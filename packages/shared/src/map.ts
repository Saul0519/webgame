import type { Vec3 } from './math.js';

export const enum Surface {
  Concrete = 0,
  Metal = 1,
  Crate = 2,
  Grate = 3,
  Emissive = 4,
  Rubber = 5,
  Sand = 6,
}

/** Axis-aligned convex brush. Everything in the level is built from these. */
export interface Brush {
  min: [number, number, number];
  max: [number, number, number];
  surf: Surface;
  /** Purely cosmetic: rotates the triplanar UVs on the client. */
  uvScale?: number;
  /** Non-solid brushes are rendered but not collided with (light strips, decals). */
  nonSolid?: boolean;
}

export interface SpawnPoint {
  pos: [number, number, number];
  yaw: number;
}

export interface LightDef {
  pos: [number, number, number];
  color: number;
  intensity: number;
  distance: number;
}

export interface GameMap {
  id: string;
  name: string;
  brushes: Brush[];
  spawns: SpawnPoint[];
  lights: LightDef[];
  /** World bounds used for the broadphase grid and out-of-bounds kill. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  killZ: number;
  /** Sun direction (points from the sun toward the world). */
  sun: { dir: [number, number, number]; color: number; intensity: number };
  fog: { color: number; near: number; far: number };
}

function box(
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  surf: Surface,
  extra?: Partial<Brush>,
): Brush {
  return {
    min: [x - sx / 2, y, z - sz / 2],
    max: [x + sx / 2, y + sy, z + sz / 2],
    surf,
    ...extra,
  };
}

/**
 * "Reactor" — a symmetric mid-size arena for 6-12 players.
 * Ground floor ring, raised centre platform reachable by four ramps, and an
 * upper catwalk that overlooks the pit. Built entirely from brushes so the
 * server can collide against it without shipping any art.
 */
function buildReactor(): GameMap {
  const B: Brush[] = [];
  const HS = 32; // half-size of the arena
  const WALL_H = 16;
  const T = 1; // wall thickness

  // Floor. The arena is open to the sky; only the outer ring is roofed, which
  // gives strong lit/shaded contrast instead of flat interior lighting.
  B.push({ min: [-HS, -1, -HS], max: [HS, 0, HS], surf: Surface.Concrete, uvScale: 0.25 });
  const ROOF_IN = 19;
  B.push({ min: [-HS, WALL_H, -HS], max: [HS, WALL_H + T, -ROOF_IN], surf: Surface.Metal, uvScale: 0.2 });
  B.push({ min: [-HS, WALL_H, ROOF_IN], max: [HS, WALL_H + T, HS], surf: Surface.Metal, uvScale: 0.2 });
  B.push({ min: [-HS, WALL_H, -ROOF_IN], max: [-ROOF_IN, WALL_H + T, ROOF_IN], surf: Surface.Metal, uvScale: 0.2 });
  B.push({ min: [ROOF_IN, WALL_H, -ROOF_IN], max: [HS, WALL_H + T, ROOF_IN], surf: Surface.Metal, uvScale: 0.2 });
  // Roof trusses spanning the open centre: they cast long shadows across the pit.
  for (let i = -2; i <= 2; i++) {
    B.push({ min: [-ROOF_IN, WALL_H, i * 8 - 0.35], max: [ROOF_IN, WALL_H + 0.7, i * 8 + 0.35], surf: Surface.Metal });
  }

  // Outer walls
  B.push({ min: [-HS - T, 0, -HS - T], max: [HS + T, WALL_H, -HS], surf: Surface.Concrete });
  B.push({ min: [-HS - T, 0, HS], max: [HS + T, WALL_H, HS + T], surf: Surface.Concrete });
  B.push({ min: [-HS - T, 0, -HS], max: [-HS, WALL_H, HS], surf: Surface.Concrete });
  B.push({ min: [HS, 0, -HS], max: [HS + T, WALL_H, HS], surf: Surface.Concrete });

  // --- Centre reactor platform (raised 3m) with four ramps ---
  const CP = 9; // platform half-size
  B.push({ min: [-CP, 0, -CP], max: [CP, 3, CP], surf: Surface.Metal, uvScale: 0.35 });
  // Reactor core column
  B.push(box(0, 3, 0, 3.2, 8, 3.2, Surface.Metal, { uvScale: 0.5 }));
  B.push(box(0, 3.2, 0, 3.6, 0.35, 3.6, Surface.Emissive, { nonSolid: true }));
  B.push(box(0, 9.4, 0, 3.6, 0.35, 3.6, Surface.Emissive, { nonSolid: true }));

  // Ramps built as stair steps (server-friendly, and STEP_HEIGHT climbs them)
  const rampSteps = 8;
  for (let i = 0; i < rampSteps; i++) {
    const h = ((i + 1) / rampSteps) * 3;
    const off = CP + (rampSteps - i) * 0.9;
    const w = 5.5;
    B.push({ min: [-w / 2, 0, off - 0.9], max: [w / 2, h, off], surf: Surface.Grate });
    B.push({ min: [-w / 2, 0, -off], max: [w / 2, h, -off + 0.9], surf: Surface.Grate });
    B.push({ min: [off - 0.9, 0, -w / 2], max: [off, h, w / 2], surf: Surface.Grate });
    B.push({ min: [-off, 0, -w / 2], max: [-off + 0.9, h, w / 2], surf: Surface.Grate });
  }

  // --- Upper catwalk ring at y=7 ---
  const CW = 26; // catwalk outer offset
  const cwW = 4;
  for (const s of [-1, 1]) {
    B.push({ min: [-CW, 7, s * CW - cwW / 2], max: [CW, 7.4, s * CW + cwW / 2], surf: Surface.Grate, uvScale: 0.4 });
    B.push({ min: [s * CW - cwW / 2, 7, -CW], max: [s * CW + cwW / 2, 7.4, CW], surf: Surface.Grate, uvScale: 0.4 });
    // railings (thin, solid so you can't fall through immediately)
    B.push({ min: [-CW, 7.4, s * (CW + cwW / 2) - 0.1], max: [CW, 8.4, s * (CW + cwW / 2) + 0.1], surf: Surface.Metal });
    B.push({ min: [s * (CW + cwW / 2) - 0.1, 7.4, -CW], max: [s * (CW + cwW / 2) + 0.1, 8.4, CW], surf: Surface.Metal });
  }

  // Corner stair towers up to the catwalk
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 14; i++) {
        const h = ((i + 1) / 14) * 7;
        const d = 20 + i * 0.8;
        B.push({
          min: [sx * d - 2.2, 0, sz * d - 2.2],
          max: [sx * d + 2.2, h, sz * d + 2.2],
          surf: Surface.Metal,
        });
      }
    }
  }

  // --- Cover: crates, pipes, barricades (4-way symmetric) ---
  const covers: [number, number, number, number, number, Surface][] = [
    [16, 0, 0, 2.4, 2.4, Surface.Crate],
    [16, 2.4, 0, 1.6, 1.6, Surface.Crate],
    [13, 0, 9, 3.2, 1.3, Surface.Concrete],
    [21, 0, -7, 2.0, 3.0, Surface.Crate],
    [8, 0, 20, 4.5, 1.2, Surface.Concrete],
    [24, 0, 18, 2.6, 2.6, Surface.Crate],
    [11, 0, 26, 2.2, 4.0, Surface.Metal],
  ];
  for (const [cx, cy, cz, w, h, surf] of covers) {
    for (let r = 0; r < 4; r++) {
      const a = (r * Math.PI) / 2;
      const s = Math.sin(a);
      const c = Math.cos(a);
      const rx = cx * c - cz * s;
      const rz = cx * s + cz * c;
      B.push(box(rx, cy, rz, w, h, w, surf));
    }
  }

  // Ceiling light strips
  for (const s of [-1, 1]) {
    B.push({
      min: [-HS + 2, WALL_H - 0.3, s * 25 - 0.4],
      max: [HS - 2, WALL_H - 0.05, s * 25 + 0.4],
      surf: Surface.Emissive,
      nonSolid: true,
    });
    B.push({
      min: [s * 25 - 0.4, WALL_H - 0.3, -HS + 2],
      max: [s * 25 + 0.4, WALL_H - 0.05, HS - 2],
      surf: Surface.Emissive,
      nonSolid: true,
    });
  }

  const spawns: SpawnPoint[] = [];
  const spawnRing: [number, number, number][] = [
    [0, 0, 27],
    [27, 0, 0],
    [0, 0, -27],
    [-27, 0, 0],
    [20, 0, 20],
    [-20, 0, 20],
    [20, 0, -20],
    [-20, 0, -20],
    [0, 7.4, 26],
    [26, 7.4, 0],
    [0, 7.4, -26],
    [-26, 7.4, 0],
  ];
  for (const [x, y, z] of spawnRing) {
    // yaw=0 looks down -Z, so atan2(x, z) points the player back at the centre.
    spawns.push({ pos: [x, y + 0.1, z], yaw: Math.atan2(x, z) });
  }

  const lights: LightDef[] = [
    { pos: [0, 8, 0], color: 0x5fd0ff, intensity: 40, distance: 30 },
  ];
  for (const [sx, sz] of [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ] as const) {
    lights.push({ pos: [sx * 20, 10, sz * 20], color: 0xffe6c0, intensity: 25, distance: 34 });
  }

  return {
    id: 'reactor',
    name: 'Reactor',
    brushes: B,
    spawns,
    lights,
    bounds: { min: [-HS - 2, -4, -HS - 2], max: [HS + 2, WALL_H + 2, HS + 2] },
    killZ: -12,
    sun: { dir: [-0.42, -0.62, -0.66], color: 0xffeacd, intensity: 3.1 },
    fog: { color: 0x9db3c8, near: 40, far: 190 },
  };
}

let _reactor: GameMap | null = null;
export function getMap(id: string): GameMap {
  if (!_reactor) _reactor = buildReactor();
  if (id !== _reactor.id) throw new Error(`unknown map: ${id}`);
  return _reactor;
}

export const DEFAULT_MAP_ID = 'reactor';

export function pickSpawn(
  map: GameMap,
  occupied: Vec3[],
  rand: () => number,
): SpawnPoint {
  // Prefer the spawn furthest from any living player, with a little jitter so
  // it does not become deterministic and campable.
  let best = map.spawns[0];
  let bestScore = -Infinity;
  for (const sp of map.spawns) {
    let nearest = Infinity;
    for (const o of occupied) {
      const dx = o.x - sp.pos[0];
      const dy = o.y - sp.pos[1];
      const dz = o.z - sp.pos[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < nearest) nearest = d2;
    }
    const score = (nearest === Infinity ? 1e6 : nearest) + rand() * 120;
    if (score > bestScore) {
      bestScore = score;
      best = sp;
    }
  }
  return best;
}
