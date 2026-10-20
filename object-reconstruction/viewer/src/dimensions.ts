import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import type { Scene } from '@babylonjs/core/scene';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { arrowRotation } from './coordinates';
import type { Vec3 } from './manifest';

export const AXIS_DIRECTIONS = { X: [1, 0, 0], Y: [0, 0, -1], Z: [0, 1, 0] } as const;
export type Axis = keyof typeof AXIS_DIRECTIONS;
const COLORS = { X: '#c64745', Y: '#25854c', Z: '#326cc7' };
export const UNIT_METERS = { mm: .001, cm: .01, m: 1 };
type Unit = keyof typeof UNIT_METERS;
interface Calibration { axis: Axis; value: number; unit: Unit; scale: number; dimensions_m: Record<Axis, number> }
interface Dimensions { run_id: string; base: { bounds: { min: Vec3; max: Vec3 }; lengths: Record<Axis, number> }; calibration: Calibration | null }
const axes = Object.keys(AXIS_DIRECTIONS) as Axis[];
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function scaledCameraPoint(point: Vec3, ratio: number): Vec3 {
  return point.map(n => n * ratio) as Vec3;
}

export class DimensionControls {
  private readonly abort = new AbortController();
  private data: Dimensions | null = null;
  private selected: Axis | null = null;
  private busy = false;
  private disposed = false;
  private axesRoot: TransformNode | null = null;
  private materials: Partial<Record<Axis, StandardMaterial>> = {};
  private tips: Partial<Record<Axis, Vector3>> = {};
  private projected: Partial<Record<Axis, { x: number; y: number }>> = {};
  private listeners: (() => void)[] = [];
  private previousUnit: Unit = 'm';
  private readonly endpoint: string;

  constructor(private scene: Scene, private metricRoot: TransformNode, private camera: ArcRotateCamera,
              private runId: string, origin: string, private onScale: (scale: number) => void) {
    this.endpoint = `${origin}/viewforge/dimensions/${encodeURIComponent(runId)}`;
    element<HTMLInputElement>('dimension-value').value = '';
    element<HTMLSelectElement>('dimension-unit').value = 'm';
    element<HTMLInputElement>('dimension-axes').checked = true;
    element('dimension-summary').textContent = '未标定';
    element('dimension-message').textContent = '正在读取物体尺寸…';
    element('dimension-reload').hidden = true;
    element('dimension-export').hidden = true;
    for (const axis of axes) {
      this.listen(`dimension-${axis}`, 'click', () => this.select(axis));
      this.listen(`axis-label-${axis}`, 'click', () => this.select(axis));
    }
    this.listen('dimension-value', 'input', () => this.update());
    this.listen('dimension-form', 'submit', (event) => { event.preventDefault(); void this.save(false); });
    this.listen('dimension-reset', 'click', () => { void this.save(true); });
    this.listen('dimension-reload', 'click', () => { void this.load(); });
    this.listen('dimension-axes', 'change', () => this.axesRoot?.setEnabled(element<HTMLInputElement>('dimension-axes').checked));
    this.listen('dimension-unit', 'change', () => {
      const field = element<HTMLInputElement>('dimension-value');
      const unit = this.unit();
      if (field.value && Number.isFinite(field.valueAsNumber)) field.value = String(Number((field.valueAsNumber * UNIT_METERS[this.previousUnit] / UNIT_METERS[unit]).toPrecision(10)));
      this.previousUnit = unit;
      this.update();
    });
    const observer = scene.onPointerObservable.add(info => {
      if (info.type === PointerEventTypes.POINTERTAP) {
        const axis = this.axisAtPointer();
        if (axis) this.select(axis);
      }
    });
    this.listeners.push(() => scene.onPointerObservable.remove(observer));
    this.update();
    void this.load();
  }

  private listen(id: string, event: string, listener: (event: Event) => void) {
    const node = element(id);
    node.addEventListener(event, listener);
    this.listeners.push(() => node.removeEventListener(event, listener));
  }

  private unit() { return element<HTMLSelectElement>('dimension-unit').value as Unit; }

  private async request(body?: object): Promise<Dimensions> {
    const response = await fetch(this.endpoint, { signal: this.abort.signal, credentials: 'same-origin', cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('尺寸服务暂不可用，请稍后重试');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '尺寸保存失败，请重试');
    const bounds = data.base?.bounds;
    if (data.run_id !== this.runId || !bounds || ![bounds.min, bounds.max].every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) ||
        !axes.every(axis => Number.isFinite(data.base.lengths[axis]) && data.base.lengths[axis] >= 0) ||
        (data.calibration && (!Number.isFinite(data.calibration.scale) || data.calibration.scale <= 0 || !axes.includes(data.calibration.axis) || !(data.calibration.unit in UNIT_METERS)))) {
      throw new Error('尺寸信息无效，请重试');
    }
    return data;
  }

  private async load() {
    this.busy = true; this.update();
    try {
      const data = await this.request();
      if (this.disposed) return;
      this.data = data;
      this.createAxes();
      this.adopt(data, 'm');
      element('dimension-reload').hidden = true;
    } catch (error) {
      if (!this.disposed) {
        element('dimension-message').textContent = error instanceof Error ? error.message : '尺寸读取失败';
        element('dimension-reload').hidden = false;
      }
    } finally { if (!this.disposed) { this.busy = false; this.update(); } }
  }

  private adopt(data: Dimensions, displayUnit?: Unit) {
    this.data = data;
    this.selected = data.calibration?.axis ?? 'Z';
    const unit = displayUnit ?? data.calibration?.unit ?? 'm';
    element<HTMLSelectElement>('dimension-unit').value = unit;
    this.previousUnit = unit;
    element<HTMLInputElement>('dimension-value').value = data.calibration ? String(Number((data.calibration.dimensions_m[data.calibration.axis] / UNIT_METERS[unit]).toPrecision(10))) : '';
    this.onScale(data.calibration?.scale ?? 1);
    element('dimension-message').textContent = data.calibration
      ? `已保存：${data.calibration.axis} 轴为实测，另两轴为等比例推算。`
      : '已默认选择 Z（向上）。输入实际高度后点击“应用并保存”；也可点击 X / Y 改用其他方向。';
  }

  private select(axis: Axis) {
    if (this.busy || !this.data || this.data.base.lengths[axis] <= 0) return;
    if (this.selected !== axis) element<HTMLInputElement>('dimension-value').value = '';
    this.selected = axis;
    element('dimension-message').textContent = `已选择 ${axis} 轴${axis === 'Z' ? '（向上）' : ''}，请输入该方向的实际整体长度。`;
    this.update();
    element<HTMLInputElement>('dimension-value').focus({ preventScroll: true });
  }

  private async save(reset: boolean) {
    if (this.busy || !this.data || (!reset && !this.selected)) return;
    const value = element<HTMLInputElement>('dimension-value').valueAsNumber;
    if (!reset && (!Number.isFinite(value) || value <= 0)) return;
    this.busy = true; this.update();
    element('dimension-message').textContent = '正在保存…';
    try {
      const data = await this.request(reset ? { reset: true } : { axis: this.selected, value, unit: this.unit() });
      if (!this.disposed) {
        this.adopt(data);
        if (!reset) element('dimension-message').textContent += ' 在 RoomCanvas「导入物体」中重新选择该物体即可读取实测尺寸。';
      }
    } catch (error) {
      if (!this.disposed) element('dimension-message').textContent = error instanceof Error ? error.message : '保存失败，请重试';
    } finally { if (!this.disposed) { this.busy = false; this.update(); } }
  }

  private createAxes() {
    this.axesRoot?.dispose(false, true);
    const root = this.axesRoot = new TransformNode('measurement-axes', this.scene);
    root.parent = this.metricRoot;
    root.setEnabled(element<HTMLInputElement>('dimension-axes').checked);
    const { min, max } = this.data!.base.bounds;
    const origin = new Vector3(min[0], min[1], max[2]);
    const size = Math.max(...Object.values(this.data!.base.lengths));
    const corners = Array.from({ length: 8 }, (_, i) => new Vector3(...min.map((n, j) => i & (1 << j) ? max[j] : n) as Vec3));
    const lines: Vector3[][] = [];
    for (let i = 0; i < 8; i++) for (let j = 0; j < 3; j++) if (!(i & (1 << j))) lines.push([corners[i], corners[i | (1 << j)]]);
    const box = CreateLineSystem('dimension-bounds', { lines }, this.scene);
    box.parent = root; box.color = Color3.FromHexString('#729482'); box.alpha = .4; box.isPickable = false; box.renderingGroupId = 1;
    // Measurement guides stay selectable even when an edge lies behind the mesh.
    this.scene.setRenderingAutoClearDepthStencil(1, true, true, false);
    for (const axis of axes) {
      const length = Math.max(this.data!.base.lengths[axis], size * .15);
      const direction = Vector3.FromArray([...AXIS_DIRECTIONS[axis]]);
      const end = origin.add(direction.scale(length));
      this.tips[axis] = end;
      const group = new TransformNode(`measurement-${axis}`, this.scene);
      group.parent = root; group.position.copyFrom(origin);
      group.rotationQuaternion = arrowRotation(origin.asArray() as Vec3, end.asArray() as Vec3);
      const material = new StandardMaterial(`measurement-color-${axis}`, this.scene);
      material.disableLighting = true;
      material.emissiveColor = Color3.FromHexString(COLORS[axis]);
      this.materials[axis] = material;
      const head = Math.min(size * .055, length * .2);
      const shaft = CreateCylinder(`measurement-shaft-${axis}`, { height: length - head, diameter: size * .012, tessellation: 12 }, this.scene);
      shaft.position.y = (length - head) / 2;
      const tip = CreateCylinder(`measurement-tip-${axis}`, { height: head, diameterTop: 0, diameterBottom: size * .045, tessellation: 12 }, this.scene);
      tip.position.y = length - head / 2;
      for (const mesh of [shaft, tip]) {
        mesh.parent = group; mesh.material = material; mesh.isPickable = true;
        mesh.metadata = { dimensionAxis: axis }; mesh.renderingGroupId = 1;
      }
    }
  }

  private update() {
    const value = element<HTMLInputElement>('dimension-value');
    value.disabled = this.busy || !this.selected;
    value.setAttribute('aria-label', this.selected ? `${this.selected} 轴实际长度` : '实际长度');
    element<HTMLSelectElement>('dimension-unit').disabled = this.busy;
    element<HTMLButtonElement>('dimension-apply').disabled = this.busy || !this.selected || !Number.isFinite(value.valueAsNumber) || value.valueAsNumber <= 0;
    element<HTMLButtonElement>('dimension-reset').disabled = this.busy || !this.data?.calibration;
    for (const axis of axes) {
      for (const prefix of ['dimension-', 'axis-label-']) {
        const button = element<HTMLButtonElement>(prefix + axis);
        button.disabled = this.busy || !this.data || this.data.base.lengths[axis] <= 0;
        button.setAttribute('aria-pressed', String(this.selected === axis));
      }
      if (this.materials[axis]) this.materials[axis]!.emissiveColor = Color3.FromHexString(COLORS[axis]).scale(this.selected && this.selected !== axis ? .6 : 1);
    }
    const calibrated = this.data?.calibration;
    const unit = this.unit();
    element('dimension-summary').textContent = calibrated ? axes.map(axis => {
      const length = Number((calibrated.dimensions_m[axis] / UNIT_METERS[unit]).toPrecision(6));
      return `${axis} ${length} ${unit}${axis === calibrated.axis ? '（实测）' : '（推算）'}`;
    }).join(' · ') : '未标定';
    const link = element<HTMLAnchorElement>('dimension-export');
    link.hidden = !calibrated; link.href = `${this.endpoint}/model.glb`;
  }

  render() {
    const canvas = this.scene.getEngine().getRenderingCanvas()!;
    for (const axis of axes) {
      const label = element(`axis-label-${axis}`);
      if (this.disposed || !this.axesRoot?.isEnabled() || !this.tips[axis]) { label.hidden = true; continue; }
      const point = Vector3.Project(this.tips[axis]!, this.metricRoot.computeWorldMatrix(true), this.scene.getTransformMatrix(),
        this.camera.viewport.toGlobal(canvas.clientWidth, canvas.clientHeight));
      const visible = point.z >= 0 && point.z <= 1 && point.x >= 0 && point.x <= canvas.clientWidth && point.y >= 0 && point.y <= canvas.clientHeight;
      label.hidden = !visible;
      this.projected[axis] = { x: point.x, y: point.y };
      label.style.left = `${point.x}px`; label.style.top = `${point.y}px`;
    }
  }

  axisAtPointer(): Axis | null {
    if (!this.axesRoot?.isEnabled()) return null;
    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY,
      mesh => mesh.isEnabled() && !!mesh.metadata?.dimensionAxis);
    return pick?.pickedMesh?.metadata?.dimensionAxis ?? null;
  }

  snapshot() { return { selectedAxis: this.selected, calibration: this.data?.calibration ?? null, base: this.data?.base ?? null,
    guidesVisible: this.axesRoot?.isEnabled() ?? false, axes: AXIS_DIRECTIONS, projected: this.projected, busy: this.busy }; }

  dispose() {
    this.disposed = true; this.abort.abort();
    for (const remove of this.listeners) remove();
    this.axesRoot?.dispose(false, true);
    for (const axis of axes) element(`axis-label-${axis}`).hidden = true;
  }
}
