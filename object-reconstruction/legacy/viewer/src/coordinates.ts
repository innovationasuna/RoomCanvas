import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Manifest, Vec3 } from "./manifest";

export function vector(value: Vec3): Vector3 {
  return Vector3.FromArray(value);
}

export function transformPoint(point: Vec3, transform: number[]): Vec3 {
  return Vector3.TransformCoordinates(vector(point), Matrix.FromArray(transform)).asArray() as Vec3;
}

/** Orient the arrow's +Y shaft from the recommended camera toward its target. */
export function arrowRotation(position: Vec3, target: Vec3): Quaternion {
  const direction = vector(target).subtract(vector(position)).normalize();
  const up = Vector3.Up();
  const dot = Vector3.Dot(up, direction);
  if (dot > 1 - 1e-8) return Quaternion.Identity();
  if (dot < -1 + 1e-8) return Quaternion.RotationAxis(Vector3.Right(), Math.PI);
  return Quaternion.RotationAxis(Vector3.Cross(up, direction).normalize(), Math.acos(Math.max(-1, Math.min(1, dot))));
}

/**
 * Babylon 8.2.0's PLY converter flips Y/Z, then _makeSplat flips Y again.
 * Net decoder transform is diag(1, 1, -1); raw .splat decoding flips only Y.
 * Undo that on a child node BEFORE the manifest's native-to-display parent.
 * Source: @babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh.js
 * (_GetSplat, _makeSplat; pinned upstream tag 8.2.0, TS lines 959–966 / 1295–1301).
 * Do not compensate in the backend or normalize either asset independently.
 */
export function gaussianDecoderCorrection(isPly: boolean): Vector3 {
  return isPly ? new Vector3(1, 1, -1) : new Vector3(1, -1, 1);
}

/** Fit one overview around the object AND camera marker, viewed from its side. */
export function overviewCamera(manifest: Pick<Manifest, "display" | "recommendation">, aspect: number) {
  const center = vector(manifest.display.center);
  const radius = manifest.display.radius;
  const up = vector(manifest.display.up).normalize();
  const recommendation = manifest.recommendation;
  let radial = recommendation ? vector(recommendation.position).subtract(center) : new Vector3(0, 0, 1);
  radial = radial.subtract(up.scale(Vector3.Dot(radial, up)));
  if (radial.lengthSquared() < 1e-8) {
    radial = Math.abs(up.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
    radial = radial.subtract(up.scale(Vector3.Dot(radial, up)));
  }
  radial.normalize();
  const yaw = recommendation ? 75 * Math.PI / 180 : 28 * Math.PI / 180;
  const side = Vector3.Cross(up, radial).normalize();
  const direction = radial.scale(Math.cos(yaw)).add(side.scale(Math.sin(yaw))).add(up.scale(0.35)).normalize();
  let fitCenter = center.clone();
  let fitRadius = radius;
  if (recommendation) {
    const cameraPosition = vector(recommendation.position);
    const arrowDirection = vector(recommendation.target).subtract(cameraPosition).normalize();
    // Shaft + tip extend 0.39 object radii toward the target. Enclose the whole
    // marker in a second sphere, then fit the union without changing asset scale.
    const markerCenter = cameraPosition.add(arrowDirection.scale(radius * 0.195));
    const markerRadius = radius * 0.21;
    const offset = markerCenter.subtract(center);
    const gap = offset.length();
    if (gap + markerRadius > radius) {
      fitRadius = (gap + radius + markerRadius) / 2;
      fitCenter = center.add(offset.scale((fitRadius - radius) / gap));
    }
  }
  const fov = 0.82;
  const halfFov = Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * Math.max(0.1, aspect)));
  const distance = fitRadius / Math.sin(halfFov) * 1.18;
  return {
    position: fitCenter.add(direction.scale(distance)).asArray() as Vec3,
    target: fitCenter.asArray() as Vec3,
    up: up.asArray() as Vec3,
    fov_y: fov,
  };
}
