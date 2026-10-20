import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { OAuth2Client } from 'google-auth-library';
import { zipSync } from 'fflate';
import type { RoomRecord } from '../src/integration/room-types.ts';
import { maxArchiveBytes, readRoomArchive, RequestError, roomName } from './room-archive.ts';

type StoredRoom = RoomRecord & {deletedAt?: number};
type Session = {guest: string; owner: string; csrf: string; nonce: string; expires: number; signedAt?: number; user?: {name: string; email: string}};
type Store = {sessions: Record<string, Session>; rooms: Record<string, StoredRoom[]>};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const day = 86400000;
const cookieName = 'roomcanvas_session';
const roomId = /^(office|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage, max: number) {
  if (Number(req.headers['content-length']) > max) throw new RequestError('上传文件过大', 413);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new RequestError('上传文件过大', 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface ApiOptions {
  dataRoot: string;
  repoRoot: string;
  clientId?: string;
  verifyGoogle?: (credential: string, audience: string) => Promise<{sub: string; nonce?: string; name?: string; email?: string; email_verified?: boolean}>;
}

export function createLocalApi(options: ApiOptions) {
  const clientId = options.clientId?.trim() || '';
  const oauth = new OAuth2Client();
  const verify = options.verifyGoogle || (async (credential: string, audience: string) => {
    const ticket = await oauth.verifyIdToken({idToken: credential, audience});
    const payload = ticket.getPayload();
    if (!payload) throw new RequestError('Google 登录验证失败', 401);
    return payload as typeof payload & {nonce?: string};
  });
  const file = resolve(options.dataRoot, 'library.json');
  let store: Store | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  async function save() {
    await mkdir(options.dataRoot, {recursive: true, mode: 0o700});
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(store), {mode: 0o600});
    await rename(temporary, file);
  }
  async function load() {
    if (store) return store;
    try { store = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; store = {sessions: {}, rooms: {}}; }
    if (!store?.rooms || !store.sessions) throw new Error('本机房间索引无法读取');
    for (const rooms of Object.values(store.rooms)) for (const room of rooms) {
      if (!room.layoutId) {room.layoutId = room.kind === 'example' ? randomUUID() : room.id; room.legacyLayout = room.kind === 'example';}
    }
    for (const [key, session] of Object.entries(store.sessions)) if (session.expires < Date.now()) delete store.sessions[key];
    await save();
    return store;
  }
  function seed(owner: string) {
    if (!store!.rooms[owner]) {
      const now = Date.now();
      store!.rooms[owner] = [{id: 'office', layoutId: randomUUID(), legacyLayout: true, name: '书房与会客区', kind: 'example', cover: 'office', objectCount: 15, createdAt: now, updatedAt: now}];
    }
    return store!.rooms[owner];
  }
  function setCookie(res: ServerResponse, value: string) {
    res.setHeader('Set-Cookie', `${cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
  }
  function publicSession(session: Session) {return {csrf: session.csrf, nonce: session.nonce, clientId, user: session.user || null};}
  function publicRoom(room: StoredRoom) {
    const {deletedAt: _, ...record} = room;
    return record;
  }
  function lookup(session: Session, id: string, allowDeleted = false) {
    if (!roomId.test(id)) throw new RequestError('找不到这个房间', 404);
    const room = seed(session.owner).find(room => room.id === id && (allowDeleted || !room.deletedAt));
    if (!room) throw new RequestError('房间已删除或不可访问', 404);
    return room;
  }
  async function streamFile(req: IncomingMessage, res: ServerResponse, path: string, type: string) {
    const info = await stat(path);
    res.writeHead(200, {'Content-Type': type, 'Content-Length': info.size, 'Last-Modified': info.mtime.toUTCString(), 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff'});
    if (req.method === 'HEAD') res.end();
    else createReadStream(path).on('error', () => res.destroy()).pipe(res);
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    // 本地服务也校验 Host 和写操作来源，防止其他网站替用户改动本机房间。
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new RequestError('请使用本机地址访问', 403);
    const url = new URL(req.url!, `http://${host}`), path = url.pathname;
    const mutating = !['GET', 'HEAD'].includes(req.method || 'GET');
    if (mutating && req.headers.origin !== url.origin) throw new RequestError('请求来源无效，请刷新页面重试', 403);
    const data = await load();
    const rawCookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    let key = rawCookie ? hash(rawCookie) : '', session = data.sessions[key];
    if (!session || session.expires < Date.now()) {
      if (mutating) throw new RequestError('会话已失效，请刷新页面重试', 401);
      const value = token(), guest = `guest:${randomUUID()}`;
      key = hash(value);
      session = {guest, owner: guest, csrf: token(), nonce: token(), expires: Date.now() + 30 * day};
      data.sessions[key] = session;
      setCookie(res, value); seed(guest); await save();
    }
    if (session.signedAt && session.signedAt + day < Date.now()) {
      session.owner = session.guest; delete session.user; delete session.signedAt; session.nonce = token(); await save();
    }
    if (mutating && req.headers['x-roomcanvas-csrf'] !== session.csrf) throw new RequestError('会话校验失败，请刷新页面重试', 403);
    if (path === '/api/session' && req.method === 'GET') return json(res, publicSession(session));
    if (path === '/api/auth/google' && req.method === 'POST') {
      if (!clientId) throw new RequestError('Google 登录尚未配置', 503);
      const input = JSON.parse((await body(req, 16384)).toString('utf8'));
      if (typeof input.credential !== 'string' || input.credential.length > 12000) throw new RequestError('登录凭证无效', 401);
      let identity;
      try {identity = await verify(input.credential, clientId);} catch {throw new RequestError('Google 登录验证失败，请重试', 401);}
      if (!identity.sub || identity.nonce !== session.nonce || !identity.email_verified) throw new RequestError('登录凭证已失效，请重新登录', 401);
      const owner = `google:${hash(identity.sub)}`;
      const guestRooms = seed(session.guest);
      if (!data.rooms[owner]) data.rooms[owner] = guestRooms;
      else for (const room of guestRooms) if (!data.rooms[owner].some(existing => existing.id === room.id)) data.rooms[owner].push(room);
      data.rooms[session.guest] = [];
      session.owner = owner; session.user = {name: identity.name || 'RoomCanvas 用户', email: identity.email || ''}; session.signedAt = Date.now();
      session.csrf = token(); session.nonce = token();
      const value = token(); delete data.sessions[key]; data.sessions[hash(value)] = session;
      setCookie(res, value); await save(); return json(res, publicSession(session));
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      session.owner = session.guest; delete session.user; delete session.signedAt;
      session.csrf = token(); session.nonce = token(); await save(); return json(res, publicSession(session));
    }
    if (path === '/api/rooms' && req.method === 'GET') return json(res, {rooms: seed(session.owner).filter(room => !room.deletedAt).map(publicRoom)});
    if (path === '/api/rooms/import' && req.method === 'POST') {
      const name = roomName(url.searchParams.get('name'));
      const archive = readRoomArchive(await body(req, maxArchiveBytes));
      const id = randomUUID(), folder = resolve(options.dataRoot, 'models', id);
      await mkdir(folder, {recursive: true, mode: 0o700});
      await writeFile(resolve(folder, 'Room.glb'), archive.model, {mode: 0o600});
      await writeFile(resolve(folder, 'room_objects.json'), archive.config, {mode: 0o600});
      const now = Date.now(), room: StoredRoom = {id, name, kind: 'imported', layoutId: id, createdAt: now, updatedAt: now, cover: archive.cover, objectCount: archive.objectCount};
      seed(session.owner).push(room); await save(); return json(res, {room: publicRoom(room)}, 201);
    }
    if (path === '/api/examples/bedroom.zip' && req.method === 'GET') {
      const folder = resolve(options.repoRoot, 'samples/room3');
      const archive = zipSync({'Room.glb': await readFile(resolve(folder, 'Room.glb')), 'room_objects.json': await readFile(resolve(folder, 'room_objects.json'))}, {level: 0});
      res.writeHead(200, {'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="RoomCanvas-bedroom.zip"', 'Content-Length': archive.byteLength, 'Cache-Control': 'no-store'});
      return res.end(archive);
    }
    const match = path.match(/^\/api\/rooms\/([^/]+)(?:\/(Room\.glb|room_objects\.json|restore|opened))?$/);
    if (match) {
      const [, id, action] = match, room = lookup(session, id, action === 'restore');
      if ((req.method === 'GET' || req.method === 'HEAD') && (action === 'Room.glb' || action === 'room_objects.json')) {
        const folder = room.kind === 'example' ? resolve(options.repoRoot, 'samples/office') : resolve(options.dataRoot, 'models', id);
        return streamFile(req, res, resolve(folder, action), action.endsWith('.glb') ? 'model/gltf-binary' : 'application/json');
      }
      if (req.method === 'PATCH' && !action) {
        const input = JSON.parse((await body(req, 4096)).toString('utf8')); room.name = roomName(input.name); room.updatedAt = Date.now();
      } else if (req.method === 'DELETE' && !action) {room.deletedAt = Date.now();}
      else if (req.method === 'POST' && action === 'restore') {delete room.deletedAt;}
      else if (req.method === 'POST' && action === 'opened') {room.openedAt = Date.now();}
      else throw new RequestError('不支持的房间操作', 405);
      await save(); return json(res, {room: publicRoom(room)});
    }
    throw new RequestError('没有找到这个接口', 404);
  }
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/')) return next();
    chain = chain.then(() => handle(req, res)).catch(error => {
      if (res.headersSent) return res.destroy();
      json(res, {error: error instanceof RequestError ? error.message : error instanceof SyntaxError ? '请求内容无法读取' : '本机服务暂时不可用，请重试'}, error instanceof RequestError ? error.status : error instanceof SyntaxError ? 400 : 500);
      if (!(error instanceof RequestError || error instanceof SyntaxError)) console.error('RoomCanvas 本机服务错误：', error.message);
    });
  };
}

export function localApiPlugin(options: ApiOptions): Plugin {
  const middleware = createLocalApi(options);
  return {name: 'roomcanvas-local-api', configureServer(server) {server.middlewares.use(middleware);}, configurePreviewServer(server) {server.middlewares.use(middleware);}};
}
