import { unzipSync } from 'fflate';

export class RequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const maxArchiveBytes = 180 * 1024 * 1024;
const maxModelBytes = 256 * 1024 * 1024;

export function roomName(value: unknown): string {
  if (typeof value !== 'string') throw new RequestError('请输入房间名称');
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > 40 || /[\x00-\x1f\x7f]/.test(name)) throw new RequestError('房间名称需要 1–40 个字');
  return name;
}

// 只接受自包含 GLB 和配套对象清单；不展开压缩包中的路径或其他文件。
export function readRoomArchive(bytes: Uint8Array) {
  if (bytes.byteLength > maxArchiveBytes) throw new RequestError('文件不能超过 180 MB', 413);
  try {
    let total = 0;
    const entries = unzipSync(bytes, {filter(entry) {
      if (entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').includes('..')) throw new RequestError('压缩包包含无效路径');
      const selected = /(^|\/)(Room\.glb|room_objects\.json)$/.test(entry.name) && !entry.name.startsWith('__MACOSX/');
      if (!selected) return false;
      total += entry.originalSize;
      const limit = entry.name.endsWith('.json') ? 4 * 1024 * 1024 : maxModelBytes;
      if (entry.originalSize > limit || total > maxModelBytes + 4 * 1024 * 1024) throw new RequestError('房间文件过大', 413);
      return true;
    }});
    const models = Object.keys(entries).filter(name => /(^|\/)Room\.glb$/.test(name));
    if (models.length !== 1) throw new RequestError('请选择一个包含 Room.glb 和 room_objects.json 的房间');
    const modelPath = models[0], configPath = modelPath.replace(/Room\.glb$/, 'room_objects.json');
    if (!entries[configPath] || Object.keys(entries).length !== 2) throw new RequestError('Room.glb 与 room_objects.json 需要放在同一文件夹');
    const model = Buffer.from(entries[modelPath]);
    if (model.length < 20 || model.toString('ascii', 0, 4) !== 'glTF' || model.readUInt32LE(4) !== 2 || model.readUInt32LE(8) !== model.length || model.readUInt32LE(16) !== 0x4e4f534a) throw new RequestError('房间模型不是有效的 GLB 2.0 文件');
    const jsonLength = model.readUInt32LE(12);
    if (jsonLength > model.length - 20 || jsonLength > 16 * 1024 * 1024) throw new RequestError('房间模型内容不完整');
    const gltf = JSON.parse(model.subarray(20, 20 + jsonLength).toString('utf8').trim());
    if (!Array.isArray(gltf.nodes) || !gltf.nodes.length || !Array.isArray(gltf.buffers) || !gltf.buffers.length) throw new RequestError('房间模型缺少场景内容');
    if ([...(gltf.buffers || []), ...(gltf.images || [])].some(entry => entry.uri)) throw new RequestError('请导入包含全部纹理和模型数据的 GLB 文件');
    const config = JSON.parse(Buffer.from(entries[configPath]).toString('utf8'));
    if (config.format !== 'roomcanvas-room-objects' || config.version !== 1 || config.frame?.up !== 'Y' || config.frame?.units !== 'meters' || !Array.isArray(config.objects) || !config.objects.length || !Array.isArray(config.groups) || !Array.isArray(config.walls) || !Array.isArray(config.ceiling)) throw new RequestError('对象清单不是受支持的 RoomCanvas 房间格式');
    const names = new Set(gltf.nodes.map((node: {name?: string}) => node.name)), ids = new Set<string>();
    for (const object of config.objects) {
      if (typeof object.id !== 'string' || !object.id || ids.has(object.id) || typeof object.node !== 'string' || !names.has(object.node)) throw new RequestError('对象清单与模型中的物体不匹配');
      // 编辑器的旧物体列表使用 HTML 模板；名称不接受标记，避免导入内容成为 HTML。
      if (['id', 'node', 'category', 'name'].some(key => typeof object[key] === 'string' && /[<>"&]/.test(object[key]))) throw new RequestError('对象名称包含不支持的字符');
      for (const key of ['bbox_min', 'bbox_max']) if (!Array.isArray(object[key]) || object[key].length !== 3 || !object[key].every(Number.isFinite)) throw new RequestError('对象清单缺少有效尺寸');
      ids.add(object.id);
    }
    if (!ids.has(config.floor) || [...config.walls, ...config.ceiling].some(id => !ids.has(id))) throw new RequestError('对象清单缺少地板或墙体');
    const groupIds = new Set<string>();
    for (const group of config.groups) {
      if (typeof group.id !== 'string' || groupIds.has(group.id) || ['id', 'name', 'category'].some(key => typeof group[key] === 'string' && /[<>"&]/.test(group[key])) || !Array.isArray(group.members) || group.members.some((id: string) => !ids.has(id)) || !Array.isArray(group.support_parts) || group.support_parts.some((node: string) => !names.has(node))) throw new RequestError('房间家具分组不完整');
      groupIds.add(group.id);
    }
    if (config.openings && (typeof config.openings !== 'object' || Object.values(config.openings).some(value => !Array.isArray(value) || value.some(id => !ids.has(id))))) throw new RequestError('房间门窗信息不完整');
    return {model, config: Buffer.from(JSON.stringify(config)), objectCount: config.groups.length, cover: /bed|room3/i.test(String(config.scene)) ? 'bedroom' as const : 'office' as const};
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('无法读取房间文件，请检查压缩包及对象清单');
  }
}
