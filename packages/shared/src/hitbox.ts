import { EYE_HEIGHT, PLAYER_CROUCH_HEIGHT, PLAYER_HEIGHT } from './constants.js';

export const enum HitPart {
  Body = 0,
  Head = 1,
  Legs = 2,
}

export interface HitboxHit {
  t: number;
  part: HitPart;
}

interface BoxDef {
  part: HitPart;
  /** Offsets relative to the player's feet position. */
  y0: number;
  y1: number;
  hx: number;
  hz: number;
}

const STANDING: BoxDef[] = [
  { part: HitPart.Legs, y0: 0.0, y1: 0.62, hx: 0.3, hz: 0.3 },
  { part: HitPart.Body, y0: 0.62, y1: EYE_HEIGHT - 0.1, hx: 0.33, hz: 0.28 },
  { part: HitPart.Head, y0: EYE_HEIGHT - 0.1, y1: EYE_HEIGHT + 0.18, hx: 0.17, hz: 0.17 },
];

const CROUCHING: BoxDef[] = [
  { part: HitPart.Legs, y0: 0.0, y1: 0.42, hx: 0.34, hz: 0.34 },
  { part: HitPart.Body, y0: 0.42, y1: PLAYER_CROUCH_HEIGHT - 0.26, hx: 0.36, hz: 0.32 },
  { part: HitPart.Head, y0: PLAYER_CROUCH_HEIGHT - 0.26, y1: PLAYER_CROUCH_HEIGHT + 0.06, hx: 0.17, hz: 0.17 },
];

export const PLAYER_BOUND_HEIGHT = PLAYER_HEIGHT + 0.2;

function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  maxDist: number,
): number {
  let tNear = 0;
  let tFar = maxDist;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const mn = [minX, minY, minZ];
  const mx = [maxX, maxY, maxZ];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-8) {
      if (o[a] < mn[a] || o[a] > mx[a]) return -1;
      continue;
    }
    let t1 = (mn[a] - o[a]) / d[a];
    let t2 = (mx[a] - o[a]) / d[a];
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tNear) tNear = t1;
    if (t2 < tFar) tFar = t2;
    if (tNear > tFar) return -1;
  }
  return tNear;
}

/**
 * Ray vs a player's hitboxes. `px/py/pz` is the target's feet position at the
 * rewound time. Returns the nearest hit part, or null.
 */
export function raycastPlayer(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  px: number,
  py: number,
  pz: number,
  crouching: boolean,
  maxDist: number,
): HitboxHit | null {
  // Cheap reject against the whole-player bound first.
  const h = crouching ? PLAYER_CROUCH_HEIGHT + 0.1 : PLAYER_BOUND_HEIGHT;
  if (rayBox(ox, oy, oz, dx, dy, dz, px - 0.42, py - 0.05, pz - 0.42, px + 0.42, py + h, pz + 0.42, maxDist) < 0) {
    return null;
  }
  const boxes = crouching ? CROUCHING : STANDING;
  let best: HitboxHit | null = null;
  for (const b of boxes) {
    const t = rayBox(
      ox, oy, oz, dx, dy, dz,
      px - b.hx, py + b.y0, pz - b.hz,
      px + b.hx, py + b.y1, pz + b.hz,
      maxDist,
    );
    if (t >= 0 && (best === null || t < best.t)) best = { t, part: b.part };
  }
  return best;
}
