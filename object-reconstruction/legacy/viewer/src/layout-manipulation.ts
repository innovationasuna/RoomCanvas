// A pose is committed only after validation. Rendering and input devices stay in the host.
export type OperationMode = 'move' | 'rotate';
export type OperationSource = 'mouse' | 'gesture';
export type Operation<T, C> = {
  original: T; candidate: T; context: C; moved: boolean;
};
export interface ManipulationPort<T, C> {
  preview(operation: Operation<T, C>): void;
  validate(operation: Operation<T, C>): Promise<T>;
  accept(candidate: T): void;
  restore(original: T): void;
  finish(context: C): void;
  error(error: unknown): void;
}
export class Manipulation<T, C> {
  current: Operation<T, C> | null = null;
  phase: 'idle' | 'preview' | 'validating' = 'idle';
  private revision = 0;
  constructor(private port: ManipulationPort<T, C>) {}
  begin(original: T, context: C) {
    if (this.phase !== 'idle') return false;
    this.revision++;
    this.current = { original: structuredClone(original), candidate: structuredClone(original), context, moved: false };
    this.phase = 'preview';
    return true;
  }
  update(change: (operation: Operation<T, C>) => void) {
    if (this.phase !== 'preview' || !this.current) return;
    change(this.current);
    this.current.moved = true;
    this.port.preview(this.current);
  }
  cancel() {
    const operation = this.current;
    if (!operation) return false;
    this.revision++;
    this.current = null;
    this.phase = 'idle';
    this.port.restore(operation.original);
    this.port.finish(operation.context);
    return true;
  }
  async commit() {
    const operation = this.current;
    if (!operation || this.phase !== 'preview') return;
    const revision = this.revision;
    this.phase = 'validating';
    try {
      if (operation.moved) {
        const candidate = await this.port.validate(operation);
        if (revision !== this.revision) return;
        this.port.accept(candidate);
      }
    } catch (error) {
      if (revision !== this.revision) return;
      this.port.restore(operation.original);
      this.port.error(error);
    } finally {
      if (revision === this.revision) {
        this.current = null;
        this.phase = 'idle';
        this.port.finish(operation.context);
      }
    }
  }
}
