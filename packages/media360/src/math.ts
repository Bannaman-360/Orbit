// Small vector / matrix helpers shared by the CPU-side 360 code.
// Conventions used everywhere in this project:
//   world/camera axes: +x right, +y up, +z forward (front lens looks along +z)
//   Mat3 is row-major: m[r*3 + c]

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export function mulMat(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return r;
}

export function mulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export function rotX(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Rotation for a virtual camera. Yaw turns right, pitch looks up, roll tilts clockwise. Radians. */
export function viewRotation(yaw: number, pitch: number, roll: number): Mat3 {
  // Positive yaw turns toward +x (right): rotY(+yaw) maps +z toward +x.
  // Positive pitch looks up: rotX(-pitch) maps +z toward +y.
  // Positive roll tilts the image clockwise: rotZ(-roll).
  return mulMat(mulMat(rotY(yaw), rotX(-pitch)), rotZ(-roll));
}

/** Axis-angle rotation matrix (Rodrigues). Axis need not be normalized. */
export function axisAngle(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

/** Smallest rotation that maps unit vector `from` onto unit vector `to`. */
export function rotationBetween(from: Vec3, to: Vec3): Mat3 {
  const f = normalize(from), t = normalize(to);
  const d = Math.max(-1, Math.min(1, dot(f, t)));
  const ax = cross(f, t);
  if (length(ax) < 1e-9) {
    if (d > 0) return IDENTITY;
    // 180°: pick any axis perpendicular to `from`.
    const perp = Math.abs(f[0]) < 0.9 ? cross(f, [1, 0, 0]) : cross(f, [0, 1, 0]);
    return axisAngle(perp, Math.PI);
  }
  return axisAngle(ax, Math.acos(d));
}

/** Unit quaternion (w, x, y, z) to rotation matrix. */
export function quatToMat([w, x, y, z]: [number, number, number, number]): Mat3 {
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** A rotation applied only partly (0 = not at all, 1 = fully). */
export function matPower(m: Mat3, k: number): Mat3 {
  if (k >= 1) return m;
  if (k <= 0) return IDENTITY;
  const c = Math.max(-1, Math.min(1, (m[0] + m[4] + m[8] - 1) / 2));
  const angle = Math.acos(c);
  if (angle < 1e-7) return m;
  const axis: Vec3 = [m[7] - m[5], m[2] - m[6], m[3] - m[1]];
  if (Math.hypot(...axis) > 1e-5) return axisAngle(axis, angle * k);
  // Half a turn: the axis is the direction the rotation leaves alone.
  const x = Math.sqrt(Math.max(0, (m[0] + 1) / 2)), y = Math.sqrt(Math.max(0, (m[4] + 1) / 2)), z = Math.sqrt(Math.max(0, (m[8] + 1) / 2));
  return axisAngle([x, m[1] + m[3] < 0 ? -y : y, m[2] + m[6] < 0 ? -z : z], angle * k);
}
