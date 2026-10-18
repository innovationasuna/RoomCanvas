// Editable objects of a reconstructed room, derived from its room_objects.json
// (written by web/scripts/room_objects.py from the reconstruction's room_layout.json).
export const FORMAT = 'roomcanvas-room-objects';

const LABELS = {
  bed: '床', chair: '椅子', sofa: '沙发', stool: '凳子', bench: '长凳', table: '桌子', desk: '书桌',
  storage: '柜子', cabinet: '柜子', wardrobe: '衣柜', bookcase: '书架', shelf: '搁板', counter: '台面',
  whiteboard: '白板', stand: '支架', fan: '风扇', lamp: '台灯', bin: '垃圾桶', bag: '袋子', shoe: '鞋',
  book: '书', paper: '纸张', picture: '挂画', mirror: '镜子', clock: '钟', plant: '植物', rug: '地毯',
  tv: '电视', monitor: '显示器', camera: '相机', bottle: '瓶子', pillow: '枕头', duvet: '被子',
  textile: '织物', stationery: '文具', magnet: '磁贴', panel: '面板', piano: '钢琴', shelf_brackets: '层架',
  board: '板', heater: '暖风机', footrest: '脚踏', air_conditioner: '空调', trim: '踢脚线', electrical_trunking: '线槽',
  conduit: '线管', boxed_services: '包管', detector: '烟感', light_fixture: '灯', ceiling_grid: '吊顶格栅', environment: '窗外景',
  wall: '墙面', floor: '地面', ceiling: '天花板', bulkhead: '吊顶', door: '门', window: '窗户',
  socket: '插座', switch: '开关', vent: '通风口', light: '灯', cable: '电线', curtain: '窗帘', radiator: '暖气片',
};
export const categoryLabel = (category) => LABELS[category] || category;
const SEATS = new Set(['chair', 'stool', 'bench']);

export function roomConfig(doc) {
  if (doc?.format !== FORMAT || doc.version !== 1) throw new Error('物体清单 room_objects.json 格式不兼容');
  const objects = new Map(doc.objects.map((object) => [object.id, object]));
  const node = (id) => objects.get(id).node;
  const footprint = ({id}) => {
    const {bbox_min: low, bbox_max: high} = objects.get(id);
    return (high[0] - low[0]) * (high[2] - low[2]);
  };
  // Largest first: beds and cabinets lead the warehouse, slippers trail it.
  const groups = [...doc.groups].sort((a, b) => footprint(b) - footprint(a) || a.id.localeCompare(b.id));
  const total = {}, seen = {};
  for (const group of groups) total[group.category] = (total[group.category] || 0) + 1;
  const catalog = groups.map((group) => {
    const label = categoryLabel(group.category);
    seen[group.category] = (seen[group.category] || 0) + 1;
    const others = group.members.length - 1;
    // A name written by hand into room_objects.json wins over the category name.
    const name = group.name || (total[group.category] > 1 ? `${label} ${seen[group.category]}` : label);
    return {id: group.id, name, category: others ? `${label} · 连同上面 ${others} 件` : label, roots: group.members.map(node)};
  });
  const placement = Object.fromEntries(groups.map((group) => [group.id, {
    body: [node(group.id)],
    ...(group.support_parts.length ? {surfaces: group.support_parts} : {}),
    ...(group.mount === 'wall' ? {wall: true} : {}),
    // Seats are found in the chair's own mesh; see seatBand in placement.mjs.
    ...(SEATS.has(group.category) ? {seat: 'auto'} : {}),
  }]));
  const fixed = doc.objects.filter((object) => object.role !== 'furniture');
  const owners = new Map(fixed.filter((object) => object.wall).map((object) => [object.node, node(object.wall)]));
  // Small ceiling fixtures (downlights) follow the ceiling switch. A tall one with no
  // recorded wall (a curtain on a ceiling track) is matched to the wall it hangs in front of.
  const hanging = fixed.filter((object) => object.mount === 'ceiling' && !object.wall);
  const tall = (object) => object.bbox_max[1] - object.bbox_min[1] > .3;
  const ceiling = new Set([...doc.ceiling.map(node), ...hanging.filter((object) => !tall(object)).map((object) => object.node)]);
  const labels = new Map(doc.objects.map((object) => [object.node, categoryLabel(object.category)]));
  return {
    sceneId: doc.scene, title: doc.scene, units: '米', catalog, placement,
    // Parts that open (doors, cabinet doors, sashes); see joints.mjs.
    joints: doc.joints || [],
    // Every object with its group; see flattenObjects.
    nodes: doc.objects.filter((object) => object.id !== doc.floor).map((object) => ({node: object.node, group: object.group})),
    openings: Object.fromEntries(Object.entries(doc.openings).map(([wall, ids]) => [node(wall), ids.map(node)])),
    wallOwner: (name) => owners.get(name) || null,
    nearWall: hanging.filter(tall).map((object) => object.node),
    isCeiling: (name) => ceiling.has(name),
    label: (name) => labels.get(name) || null,
  };
}

// The reconstruction nests each object under what it stands on (a bed under Floor0, books
// under their shelf). Lift an object to the room root, keeping its world pose, when it sits
// under something of another group, so groups move, hide and measure on their own. Within
// a group nothing moves: lifting from a non-uniformly scaled parent would shear it.
export function flattenObjects(room, nodes) {
  const groupOf = new Map(nodes.map(({node, group}) => [node, group]));
  const found = new Map();
  room.traverse((object) => {
    const name = object.userData?.name || object.name;
    if (object !== room && groupOf.has(name) && !found.has(name)) found.set(name, object);
  });
  const missing = nodes.filter(({node}) => !found.has(node)).map(({node}) => node);
  if (missing.length) throw new Error(`房间版本不匹配，缺少物体 ${missing.join('、')}`);
  room.updateMatrixWorld(true);
  const lift = [...found].filter(([name, object]) => {
    for (let parent = object.parent; parent && parent !== room; parent = parent.parent) {
      if (groupOf.get(parent.userData?.name || parent.name) === groupOf.get(name)) return false;
    }
    return object.parent !== room;
  });
  for (const [, object] of lift) room.attach(object);
  room.updateMatrixWorld(true);
  return lift.length;
}

// The members of a group that are not inside another member: attaching these moves the rest.
export function topMembers(room, names) {
  const wanted = new Set(names), found = new Map();
  room.traverse((object) => {
    const name = object.userData?.name || object.name;
    if (wanted.has(name) && !found.has(name)) found.set(name, object);
  });
  const missing = names.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`房间版本不匹配，缺少物体 ${missing.join('、')}`);
  return [...found.values()].filter((object) => {
    for (let parent = object.parent; parent; parent = parent.parent) if (wanted.has(parent.userData?.name || parent.name)) return false;
    return true;
  });
}
