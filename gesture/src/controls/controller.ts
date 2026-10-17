import type { Action, CameraPose, GestureFrame, HandSignal, Mode, Point, Pointer, SceneId, ScenePort, Transform } from '../shared/types';
import { CONFIG, clamp } from '../shared/config';
import { constrainFurniture, copyTransform, mapXYZ } from './mapping';

interface Session {
  id?: string; base?: Transform; pointer: Pointer; lastPointer: Pointer; floor?: Point; camera: CameraPose;
  palm: number; depthLog: number; wasFacing: boolean; axes: ReturnType<ScenePort['cameraAxes']>;
  before: Record<string, Transform>;
}
export class Controller {
  mode: Mode = 'move';
  paused = false;
  needsRelease = false;
  selected?: string;
  status = '指向家具，捏合后移动';
  private session?: Session;
  private rightBlocked = false;
  private leftBlocked = false;
  private viewSession?: {pointer:Pointer;camera:CameraPose};
  private dual?: { distance: number; radius: number; scale: number; before: Record<string, Transform> };
  private histories: Record<SceneId, Record<string, Transform>[]> = { furniture: [], xyz: [] };
  private pending: Partial<Record<SceneId, Record<string, Transform>>> = {};
  constructor(readonly scene: ScenePort) {}
  get grabbing() { return !!this.session || !!this.dual || !!this.viewSession; }
  get viewing() { return !!this.viewSession || (this.mode==='observe'&&this.grabbing); }
  get undoCount() { return this.histories[this.scene.active].length; }
  action(action: Action) {
    if (action === 'close' || action === 'cancel-reset') return;
    this.interrupt();
    if (action === 'undo') {
      const last = this.pending[this.scene.active] ?? this.histories[this.scene.active].pop();
      delete this.pending[this.scene.active];
      if (last) { this.scene.restore(last); this.status = '已撤销上一次操作'; }
      else this.status = '还没有可撤销的操作';
    } else if (action === 'confirm-reset') {
      const before = this.pending[this.scene.active] ?? this.scene.snapshot(); delete this.pending[this.scene.active];
      this.scene.reset(); this.record(before); this.selected = undefined; this.status = '场景已复位';
    } else if (action === 'pause' || action === 'resume') {
      this.paused = action === 'pause'; this.status = this.paused ? '已暂停 · 张掌可打开菜单' : '已恢复 · 松手后重新抓取';
    } else if (action === 'furniture' || action === 'xyz') {
      this.scene.switchScene(action); this.mode = 'move'; this.selected = undefined;
      this.status = action === 'xyz' ? '捏合光标，手向前后移动调节深度' : '指向家具，捏合后移动';
    } else if (action !== 'reset') {
      if (action === 'scale' && this.scene.active !== 'xyz') { this.status = '真实家具保持实际尺寸'; return; }
      this.mode = action;
    }
  }
  private record(before: Record<string, Transform>) {
    if (JSON.stringify(before) === JSON.stringify(this.scene.snapshot())) return;
    const history = this.histories[this.scene.active]; history.push(before); if (history.length > 50) history.shift();
  }
  interrupt() {
    // Keep the last valid preview, but do not mistake loss for a committed placement.
    const before = this.session?.before ?? this.dual?.before;
    if (before) this.pending[this.scene.active] = before;
    this.session = undefined; this.dual = undefined; this.viewSession=undefined;this.needsRelease = true;
  }
  private begin(hand: HandSignal) {
    const id = this.scene.active === 'xyz' ? 'cursor' : this.scene.pick(hand.pointer);
    if (this.mode !== 'observe' && !id) { this.status = '先把指针移到家具上'; return; }
    this.selected = id;
    const before = this.pending[this.scene.active] ?? this.scene.snapshot(); delete this.pending[this.scene.active];
    this.session = { id, base: id ? copyTransform(this.scene.info(id)!.transform) : undefined,
      pointer: { ...hand.pointer }, lastPointer: { ...hand.pointer }, floor: this.scene.floorPoint(hand.pointer), camera: this.scene.getCamera(),
      palm: hand.palmScale, depthLog: 0, wasFacing: hand.frontFacing, axes: this.scene.cameraAxes(), before };
  }
  input(frame: GestureFrame) {
    let hand = frame.operator,helper=frame.helper;
    if (this.dual && (frame.interrupted || frame.helperInterrupted)) {
      this.interrupt(); this.status = '追踪中断 · 松手后重新抓取';
    } else {
      if (frame.interrupted) {
        if (this.session) this.pending[this.scene.active] = this.session.before;
        this.session = undefined; this.rightBlocked = true;
      }
      if (frame.helperInterrupted) { this.viewSession = undefined; this.leftBlocked = true; }
    }
    if (this.rightBlocked) { if (hand && !hand.pinching) this.rightBlocked = false; hand = undefined; }
    if (this.leftBlocked) { if (helper && !helper.pinching) this.leftBlocked = false; helper = undefined; }
    if (this.needsRelease) {
      if ((hand||helper)&&!hand?.pinching&&!helper?.pinching) this.needsRelease = false;
      return;
    }
    if (this.paused) return;
    if (this.dual && (!hand||!helper)) { this.status = '手部丢失 · 双手操作已冻结'; return; }
    const both = hand?.pinching && helper?.pinching;
    if (both && (this.mode === 'observe' || (this.mode === 'scale' && this.scene.active === 'xyz'))) {
      if(hand?.releasing || helper?.releasing)return;
      const distance = Math.hypot(hand!.pointer.x - helper!.pointer.x, hand!.pointer.y - helper!.pointer.y);
      if (!this.dual) {
        this.dual = { distance: Math.max(0.04, distance), radius: this.scene.getCamera().radius,
          scale: this.scene.info('cursor')?.transform.scale ?? 1, before: this.session?.before ?? this.pending[this.scene.active] ?? this.scene.snapshot() };
        this.session = undefined; this.viewSession=undefined;delete this.pending[this.scene.active];
      }
      const ratio = distance / this.dual.distance;
      if (this.mode === 'observe') this.scene.setCamera({ ...this.scene.getCamera(), radius: this.dual.radius / Math.max(0.2, ratio) });
      else {
        const transform = copyTransform(this.scene.info('cursor')!.transform);
        transform.scale = clamp(this.dual.scale * ratio, CONFIG.minScale, CONFIG.maxScale); this.scene.apply('cursor', transform);
      }
      this.status = this.mode === 'observe' ? '双手缩放视角' : '双手缩放展示模型'; return;
    }
    if (this.dual) {
      if (this.mode === 'scale') this.record(this.dual.before);
      this.dual = undefined; this.needsRelease = true; this.status = '双手操作结束 · 松手后继续'; return;
    }
    // 左右手会话独立；观察与缩放模式的双手操作仍由上面的分支优先处理。
    if(helper?.started&&!this.viewSession)this.viewSession={pointer:{...helper.pointer},camera:this.scene.getCamera()};
    if(this.viewSession && helper){
      if(helper.ended)this.viewSession=undefined;
      else if(helper.pinching&&!helper.releasing){
        const before=this.scene.getCamera();this.orbit(helper.pointer,this.viewSession);
        const after=this.scene.getCamera();
        if(before.theta!==after.theta || before.phi!==after.phi)this.rebaseObject();
        this.status='左手环绕观察 · 右手可同时操作物体';
      }
    }
    if (!hand) { this.status = frame.ambiguous ? '手部身份不明确 · 暂停控制' : '右手操作物体 · 左手捏合环绕'; return; }
    if (hand.started) this.begin(hand);
    if (hand.ended && this.session) {
      if (this.mode !== 'observe') this.record(this.session.before);
      this.session = undefined; this.status = '已放置 · 张掌打开菜单'; return;
    }
    const session = this.session;
    if(hand.releasing)return;
    if (!hand.pinching || !session) { this.scene.highlight(this.scene.pick(hand.pointer)); return; }
    this.scene.highlight(session.id);
    const dx = hand.pointer.x - session.pointer.x, dy = hand.pointer.y - session.pointer.y;
    if (this.mode === 'observe') {
      this.orbit(hand.pointer,session);
      this.status = '正在环绕观察'; return;
    }
    if (!session.id || !session.base) return;
    let transform = copyTransform(session.base);
    if (this.mode === 'move' && this.scene.active === 'furniture') {
      const floor = this.scene.floorPoint(hand.pointer);
      if (!floor || !session.floor) { this.status = '指针离开地板 · 位置已冻结'; return; }
      transform.position.x += floor.x - session.floor.x; transform.position.z += floor.z - session.floor.z;
    } else if (this.mode === 'move') {
      if (hand.frontFacing && session.wasFacing && session.palm > 1e-5 && hand.palmScale > 1e-5) session.depthLog += Math.log(hand.palmScale / session.palm);
      session.palm = hand.palmScale; session.wasFacing = hand.frontFacing;
      transform.position = mapXYZ(session.base.position, dx, dy, Math.exp(session.depthLog), session.axes);
    } else if (this.mode === 'rotate') {
      transform.rotation = Math.round((session.base.rotation + dx * CONFIG.rotateGain) / CONFIG.rotationSnap) * CONFIG.rotationSnap;
    } else if (this.mode === 'height') transform.position.y -= dy * CONFIG.heightGain;
    else if (this.mode === 'scale') { this.status = '请双手捏合，再拉开或靠拢'; return; }
    if (this.scene.active === 'furniture') transform = constrainFurniture(transform, this.scene.info(session.id)!.size);
    else transform.position.y = clamp(transform.position.y, 0.15, 2.8);
    this.scene.apply(session.id, transform);
    session.lastPointer = { ...hand.pointer };
    this.status = this.scene.active === 'xyz' && !hand.frontFacing ? '掌面朝向摄像头 · 深度已冻结' : '正在操作 · 松开捏合即可放置';
  }
  private rebaseObject(){
    const session=this.session;
    if(!session?.id || this.mode!=='move')return;
    // 相机转动后，以最后有效右手位置重新计算基准，避免投影变化拖走物体。
    session.base=copyTransform(this.scene.info(session.id)!.transform);
    session.pointer={...session.lastPointer};session.floor=this.scene.floorPoint(session.lastPointer);
    session.axes=this.scene.cameraAxes();session.depthLog=0;
  }
  private orbit(pointer:Pointer,session:{pointer:Pointer;camera:CameraPose}){
    const dx=pointer.x-session.pointer.x,dy=pointer.y-session.pointer.y;
    this.scene.setCamera({...session.camera,theta:session.camera.theta-dx*Math.PI*2,phi:session.camera.phi-dy*Math.PI});
  }
  mouseDown(pointer: Pointer) {
    if (this.paused) return;
    this.needsRelease = false;
    this.input({ timestamp: performance.now(), operator: this.mouseSignal(pointer, true, true), menuRequested: false, interrupted: false, ambiguous: false });
  }
  mouseMove(pointer: Pointer) {
    this.input({ timestamp: performance.now(), operator: this.mouseSignal(pointer, this.grabbing, false), menuRequested: false, interrupted: false, ambiguous: false });
  }
  mouseUp(pointer: Pointer) {
    const signal = this.mouseSignal(pointer, false, false); signal.ended = true;
    this.input({ timestamp: performance.now(), operator: signal, menuRequested: false, interrupted: false, ambiguous: false });
  }
  mouseDepth(delta: number) {
    if (this.paused) return;
    if (this.scene.active === 'xyz' && this.mode === 'move') {
      const info = this.scene.info('cursor')!; const before = this.scene.snapshot(); const t = copyTransform(info.transform);
      const axes = this.scene.cameraAxes(); t.position = mapXYZ(t.position, 0, 0, Math.exp(-delta * 0.001), axes);
      this.scene.apply('cursor', t); this.record(before);
    } else if (this.mode === 'scale' && this.scene.active === 'xyz') {
      const before = this.scene.snapshot(); const t = copyTransform(this.scene.info('cursor')!.transform);
      t.scale = clamp(t.scale * Math.exp(-delta * 0.001), CONFIG.minScale, CONFIG.maxScale); this.scene.apply('cursor', t); this.record(before);
    } else this.scene.setCamera({ ...this.scene.getCamera(), radius: this.scene.getCamera().radius * Math.exp(delta * 0.001) });
  }
  private mouseSignal(pointer: Pointer, pinching: boolean, started: boolean): HandSignal {
    return { pointer, wrist: pointer, palmScale: 1, frontFacing: true, pinching, started, ended: false, openPalm: false };
  }
}
