import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createLocalApi, type ApiOptions } from '../../server/local-api';
import { readRoomArchive, roomName } from '../../server/room-archive';

function archive(options: {external?: boolean; badNode?: boolean; path?: string; label?: string} = {}) {
  const gltf = {asset: {version: '2.0'}, buffers: [{byteLength: 4, ...(options.external ? {uri: 'https://example.org/private.bin'} : {})}], nodes: [{name: 'Floor0'}, {name: 'Chair0'}]};
  const json = JSON.stringify(gltf), padded = json.padEnd(Math.ceil(json.length / 4) * 4, ' ');
  const model = Buffer.alloc(20 + padded.length + 12);
  model.write('glTF'); model.writeUInt32LE(2, 4); model.writeUInt32LE(model.length, 8); model.writeUInt32LE(padded.length, 12); model.writeUInt32LE(0x4e4f534a, 16); model.write(padded, 20);
  model.writeUInt32LE(4, 20 + padded.length); model.writeUInt32LE(0x004e4942, 24 + padded.length);
  const config = {format: 'roomcanvas-room-objects', version: 1, scene: 'test', frame: {up: 'Y', units: 'meters'}, floor: 'Floor0', walls: [], ceiling: [], objects: ['Floor0', 'Chair0'].map(id => ({id, node: options.badNode ? 'Missing' : id, category: 'chair', bbox_min: [0, 0, 0], bbox_max: [1, 1, 1]})), groups: [{id: 'Chair0', name: options.label || '椅子', category: 'chair', members: ['Chair0'], support_parts: []}]};
  const folder = options.path || '';
  return zipSync({[folder + 'Room.glb']: model, [folder + 'room_objects.json']: strToU8(JSON.stringify(config))}, {level: 0});
}

const servers: Server[] = [], folders: string[] = [];
async function fixture(options: Partial<ApiOptions> = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'roomcanvas-api-')); folders.push(dataRoot);
  const middleware = createLocalApi({dataRoot, repoRoot: join(dataRoot, 'repo'), ...options});
  const server = createServer((req, res) => middleware(req, res, () => {res.writeHead(404); res.end();})); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  function client() {
    let cookie = '', csrf = '';
    return {async call(path: string, method = 'GET', payload?: unknown, headers: Record<string, string> = {}) {
      const response = await fetch(origin + path, {method, headers: {Origin: origin, Cookie: cookie, 'X-RoomCanvas-CSRF': csrf, ...headers}, body: payload instanceof Uint8Array ? Buffer.from(payload) : payload === undefined ? undefined : JSON.stringify(payload)});
      const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
      if (result.csrf) csrf = result.csrf;
      return {status: response.status, result};
    }};
  }
  return {client, dataRoot, origin};
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {server.closeAllConnections(); server.close(() => resolve());})));
  await Promise.all(folders.splice(0).map(folder => rm(folder, {recursive: true, force: true})));
});

describe('本地房间文件', () => {
  it('允许文件夹内的完整房间包', () => expect(readRoomArchive(archive({path: '卧室/'})).objectCount).toBe(1));
  it.each([{path: '../'}, {path: '/'}, {external: true}, {badNode: true}, {label: '<img src=x>'}])('拒绝不安全或不匹配的房间包 %j', options => expect(() => readRoomArchive(archive(options))).toThrow());
  it('名称保持纯文本并拒绝空白与过长名字', () => {expect(roomName('  我的卧室  ')).toBe('我的卧室'); expect(() => roomName('  ')).toThrow(); expect(() => roomName('家'.repeat(41))).toThrow();});
});

describe('本地房间管理 API', () => {
  it('重启服务后恢复同一会话、名称和布局实体标识', async () => {
    const initial = await fixture();
    const response = await fetch(initial.origin + '/api/session');
    const cookie = response.headers.get('set-cookie')!.split(';')[0], session = await response.json();
    const headers = {Cookie: cookie, Origin: initial.origin, 'X-RoomCanvas-CSRF': session.csrf};
    const before = await fetch(initial.origin + '/api/rooms', {headers}).then(response => response.json());
    await fetch(initial.origin + '/api/rooms/office', {method: 'PATCH', headers, body: JSON.stringify({name: '保留下来的书房'})});
    const restarted = await fixture({dataRoot: initial.dataRoot});
    const after = await fetch(restarted.origin + '/api/rooms', {headers: {Cookie: cookie}}).then(response => response.json());
    expect(after.rooms).toHaveLength(1);
    expect(after.rooms[0].name).toBe('保留下来的书房');
    expect(after.rooms[0].layoutId).toBe(before.rooms[0].layoutId);
  });
  it('只初始化一个示例；导入同一个包得到独立实体；支持改名、删除和撤销', async () => {
    const {client} = await fixture(), user = client(); await user.call('/api/session');
    expect((await user.call('/api/rooms')).result.rooms.map((room: {id: string}) => room.id)).toEqual(['office']);
    const a = (await user.call('/api/rooms/import?name=卧室', 'POST', archive())).result.room;
    const b = (await user.call('/api/rooms/import?name=卧室副本', 'POST', archive())).result.room;
    expect(a.id).not.toBe(b.id); expect(a.layoutId).not.toBe(b.layoutId);
    expect((await user.call(`/api/rooms/${a.id}/Room.glb`)).status).toBe(200);
    await user.call(`/api/rooms/${a.id}`, 'PATCH', {name: '午后的卧室'});
    expect((await user.call('/api/rooms')).result.rooms.find((room: {id: string}) => room.id === a.id).name).toBe('午后的卧室');
    await user.call(`/api/rooms/${a.id}`, 'DELETE');
    expect((await user.call(`/api/rooms/${a.id}/Room.glb`)).status).toBe(404);
    await user.call(`/api/rooms/${a.id}/restore`, 'POST');
    expect((await user.call(`/api/rooms/${a.id}/Room.glb`)).status).toBe(200);
  });
  it('未初始化、跨源写入、错误 CSRF 和其他会话的房间均被拒绝', async () => {
    const {client} = await fixture(), a = client(), b = client();
    expect((await a.call('/api/rooms/office', 'DELETE')).status).toBe(401);
    await a.call('/api/session'); await b.call('/api/session');
    expect((await a.call('/api/rooms/office', 'DELETE', undefined, {Origin: 'https://unrelated.example'})).status).toBe(403);
    expect((await a.call('/api/rooms/office', 'DELETE', undefined, {'X-RoomCanvas-CSRF': 'wrong'})).status).toBe(403);
    const room = (await a.call('/api/rooms/import?name=房间', 'POST', archive())).result.room;
    expect((await b.call(`/api/rooms/${room.id}/Room.glb`)).status).toBe(404);
    expect((await b.call(`/api/rooms/${room.id}`, 'DELETE')).status).toBe(404);
  });
  it('删除最后一个示例后刷新列表不会自动重新出现', async () => {
    const {client} = await fixture(), user = client(); await user.call('/api/session');
    await user.call('/api/rooms/office', 'DELETE');
    expect((await user.call('/api/rooms')).result.rooms).toEqual([]);
    expect((await user.call('/api/rooms')).result.rooms).toEqual([]);
  });
  it('无 Google 配置时不伪造登录成功', async () => {
    const {client} = await fixture(), user = client(); await user.call('/api/session');
    expect((await user.call('/api/auth/google', 'POST', {credential: 'fake'})).status).toBe(503);
    expect((await user.call('/api/session')).result.user).toBeNull();
  });
  it('验证登录 nonce，迁移游客导入房间，退出后隔离账户数据', async () => {
    let nonce = '';
    const {client} = await fixture({clientId: 'test-client', verifyGoogle: async token => {
      if (token === 'invalid') throw new Error('invalid');
      return {sub: 'google-test-account', nonce: token === 'replay' ? 'expired-nonce' : nonce, name: '测试用户', email: 'test@example.test', email_verified: true};
    }}), user = client();
    const session = (await user.call('/api/session')).result; nonce = session.nonce;
    const imported = (await user.call('/api/rooms/import?name=游客房间', 'POST', archive())).result.room;
    expect((await user.call('/api/auth/google', 'POST', {credential: 'invalid'})).status).toBe(401);
    expect((await user.call('/api/auth/google', 'POST', {credential: 'replay'})).status).toBe(401);
    expect((await user.call('/api/auth/google', 'POST', {credential: 'valid'})).result.user.name).toBe('测试用户');
    const owned = (await user.call('/api/rooms')).result.rooms.find((room: {id: string}) => room.id === imported.id);
    expect(owned.layoutId).toBe(imported.layoutId);
    expect((await user.call('/api/auth/google', 'POST', {credential: 'valid'})).status).toBe(401);
    await user.call('/api/auth/logout', 'POST');
    expect((await user.call('/api/session')).result.user).toBeNull();
    expect((await user.call(`/api/rooms/${imported.id}/Room.glb`)).status).toBe(404);
  });
});
