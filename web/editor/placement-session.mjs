import {copyLayout} from './layout.mjs?v=store-selected-25';

// Preview owns an isolated full-room candidate, including carried objects.
// Persist, export and recovery always read committed(), never the candidate.
export class PlacementSession {
  constructor(before, id, locked = false) {
    this.before = copyLayout(before);
    this.candidate = copyLayout(before);
    this.id = id;
    this.locked = locked;
    this.valid = false;
    this.message = '';
  }
  update(candidate, valid, message) {
    this.candidate = copyLayout(candidate);
    this.valid = Boolean(valid);
    this.message = message;
    return copyLayout(this.candidate);
  }
  committed() { return copyLayout(this.before); }
  cancel() { return this.committed(); }
  confirm() {
    if (!this.valid) return null;
    return copyLayout(this.candidate);
  }
}
