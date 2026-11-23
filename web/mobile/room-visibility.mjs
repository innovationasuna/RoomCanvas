import {createPlacement} from '../editor/placement.mjs';
import {createWallVisibility, worldVertices} from '../editor/wall-visibility.mjs';

// Older shared GLBs have names and geometry but no surface ownership metadata.
// Only architectural parts and known wall fixtures may be inferred, not arbitrary furniture.
function legacyOwner(THREE, root, walls) {
  const name = root.name, namedWall = name.match(/(?:^|_)(Wall\d+)(?:_|$)/)?.[1];
  if (walls.some(wall => wall.name === namedWall)) return namedWall;
  if (!/^(?:Editable_)?(Door|Window|Socket|Switch|Data_|Radiator|AirConditioner|ACConduit|Curtain|Vent|ShelfStandards|Whiteboard|Noticeboard)/.test(name)) return null;
  const points = worldVertices(THREE, root);
  if (!points.length) return null;
  let best = null;
  for (const wall of walls) {
    const depth = points.map(p => p[0] * wall.n[0] + p[2] * wall.n[2] - wall.d);
    const distance = Math.max(...depth.map(Math.abs));
    const along = points.map(p => p[0] * wall.tangent[0] + p[2] * wall.tangent[2]);
    if (distance > .8 || Math.min(wall.bounds[1][0], Math.max(...along)) <= Math.max(wall.bounds[0][0], Math.min(...along))) continue;
    if (!best || distance < best.distance) best = {name: wall.name, distance};
  }
  return best?.name || null;
}

export function createRoomVisibility(THREE, room) {
  let model = room;
  room.traverse(object => {if (object.userData.roomcanvas?.schema === 1) model = object;});
  const metadata = model.userData.roomcanvas?.cutaway;
  const floor = model.getObjectByName('Floor0');
  // Reuse the editor's inward-facing wall geometry and corner-return rules.
  const walls = metadata?.walls ?? (floor ? createPlacement(THREE, model, new Map(), {}, 0, Infinity).wallTargets() : []);
  const ceilings = new Set(metadata?.ceilings ?? model.children.filter(root =>
    /^(Ceiling|Downlight|SmokeDetector)|CeilingBulkhead/.test(root.name)).map(root => root.name));
  const owners = new Map(model.children.map(root => [root.name,
    metadata ? metadata.owners[root.name] : legacyOwner(THREE, root, walls)]));
  const visible = new Map(model.children.map(root => [root, root.visible]));
  const ceilingRoots = model.children.filter(root => ceilings.has(root.name));
  const labels = model.userData.roomcanvas?.lighting?.labels || {};
  const label = name => labels[name] || (/^Ceiling\d+$/.test(name) ? '天花板' : /^Window\d+$/.test(name) ? '窗户'
    : /^Wall\d+$/.test(name) ? '墙面' : /^Floor\d+$/.test(name) ? '地面' : /^Window.*Backdrop/.test(name) ? '窗外景' : null);
  const openings = {};
  for (const [name, owner] of owners) if (owner && label(name) === '窗户') (openings[owner] ||= []).push(name);
  const controller = createWallVisibility(model, walls, {
    owner: name => ceilings.has(name) ? null : owners.get(name),
    conceal(root, hidden) {
      const next = visible.get(root) && !hidden;
      if (root.visible === next) return false;
      root.visible = next;
      return true;
    },
  });
  return {
    model, walls,
    revealRoot: root => visible.get(root),
    config: {label, openings, isCeiling: name => ceilings.has(name)},
    wallRoots: model.children.filter(root => !ceilings.has(root.name) && owners.get(root.name)),
    update(direction, {walking = false} = {}) {
      const result = controller.update(direction, {enabled: !walking});
      for (const root of ceilingRoots) {
        const next = visible.get(root) && walking;
        if (root.visible !== next) {root.visible = next; result.changed = true;}
      }
      return result;
    },
  };
}
