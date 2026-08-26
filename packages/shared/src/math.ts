export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path angular lerp (radians). */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Forward direction from yaw/pitch. yaw=0 looks down -Z, pitch>0 looks up. */
export function dirFromAngles(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/**
 * Deterministic 32-bit PRNG (mulberry32). Client and server must produce the
 * same spread pattern for a given shot, so weapon randomness is seeded from
 * (playerId, shotSeq) rather than Math.random().
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotate a direction by a random offset inside a cone of the given half-angle. */
export function coneSpread(dir: Vec3, halfAngle: number, rng: () => number, out: Vec3): Vec3 {
  if (halfAngle <= 0) {
    out.x = dir.x;
    out.y = dir.y;
    out.z = dir.z;
    return out;
  }
  // Build an orthonormal basis around dir.
  const up = Math.abs(dir.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  let rx = up.y * dir.z - up.z * dir.y;
  let ry = up.z * dir.x - up.x * dir.z;
  let rz = up.x * dir.y - up.y * dir.x;
  const rl = length3(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  const ux = dir.y * rz - dir.z * ry;
  const uy = dir.z * rx - dir.x * rz;
  const uz = dir.x * ry - dir.y * rx;

  // Uniform disc sample -> small-angle cone.
  const ang = rng() * Math.PI * 2;
  const rad = Math.sqrt(rng()) * halfAngle;
  const sx = Math.cos(ang) * rad;
  const sy = Math.sin(ang) * rad;

  let ox = dir.x + rx * sx + ux * sy;
  let oy = dir.y + ry * sx + uy * sy;
  let oz = dir.z + rz * sx + uz * sy;
  const ol = length3(ox, oy, oz) || 1;
  out.x = ox / ol;
  out.y = oy / ol;
  out.z = oz / ol;
  return out;
}
