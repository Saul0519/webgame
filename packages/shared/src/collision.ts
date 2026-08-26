import type { Brush, GameMap } from './map.js';
import type { Vec3 } from './math.js';

const EPS = 1e-4;
const SKIN = 1e-3;

export interface SweepHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
  brush: number;
}

export interface RayHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
  brush: number;
}

/**
 * Broadphase over the level brushes. The arena is small and fully axis-aligned,
 * so a flat XZ grid (Y ignored) is both faster and simpler than a BVH here.
 */
export class CollisionWorld {
  readonly map: GameMap;
  readonly brushes: Brush[];
  private readonly cell = 8;
  private readonly gx0: number;
  private readonly gz0: number;
  private readonly gw: number;
  private readonly gh: number;
  private readonly grid: Int32Array[];
  private stamp = 1;
  private readonly visited: Int32Array;

  constructor(map: GameMap) {
    this.map = map;
    this.brushes = map.brushes.filter((b) => !b.nonSolid);
    const bmin = map.bounds.min;
    const bmax = map.bounds.max;
    this.gx0 = Math.floor(bmin[0] / this.cell) - 1;
    this.gz0 = Math.floor(bmin[2] / this.cell) - 1;
    this.gw = Math.ceil(bmax[0] / this.cell) - this.gx0 + 2;
    this.gh = Math.ceil(bmax[2] / this.cell) - this.gz0 + 2;

    const buckets: number[][] = [];
    for (let i = 0; i < this.gw * this.gh; i++) buckets.push([]);
    for (let i = 0; i < this.brushes.length; i++) {
      const b = this.brushes[i];
      const x0 = Math.max(0, Math.floor(b.min[0] / this.cell) - this.gx0);
      const x1 = Math.min(this.gw - 1, Math.floor(b.max[0] / this.cell) - this.gx0);
      const z0 = Math.max(0, Math.floor(b.min[2] / this.cell) - this.gz0);
      const z1 = Math.min(this.gh - 1, Math.floor(b.max[2] / this.cell) - this.gz0);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) buckets[z * this.gw + x].push(i);
      }
    }
    this.grid = buckets.map((b) => Int32Array.from(b));
    this.visited = new Int32Array(this.brushes.length);
  }

  private cellAt(x: number, z: number): Int32Array | null {
    const cx = Math.floor(x / this.cell) - this.gx0;
    const cz = Math.floor(z / this.cell) - this.gz0;
    if (cx < 0 || cz < 0 || cx >= this.gw || cz >= this.gh) return null;
    return this.grid[cz * this.gw + cx];
  }

  /** Collect candidate brush indices overlapping an XZ range. */
  private candidates(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): void {
    out.length = 0;
    const s = ++this.stamp;
    const x0 = Math.max(0, Math.floor(minX / this.cell) - this.gx0);
    const x1 = Math.min(this.gw - 1, Math.floor(maxX / this.cell) - this.gx0);
    const z0 = Math.max(0, Math.floor(minZ / this.cell) - this.gz0);
    const z1 = Math.min(this.gh - 1, Math.floor(maxZ / this.cell) - this.gz0);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const bucket = this.grid[z * this.gw + x];
        for (let i = 0; i < bucket.length; i++) {
          const bi = bucket[i];
          if (this.visited[bi] !== s) {
            this.visited[bi] = s;
            out.push(bi);
          }
        }
      }
    }
  }

  private scratch: number[] = [];

  /**
   * Swept AABB against the level. `half` is the box half-extent; position is the
   * box centre. Returns the earliest hit, or null.
   */
  sweepBox(px: number, py: number, pz: number, half: Vec3, dx: number, dy: number, dz: number): SweepHit | null {
    const minX = Math.min(px, px + dx) - half.x - 1;
    const maxX = Math.max(px, px + dx) + half.x + 1;
    const minZ = Math.min(pz, pz + dz) - half.z - 1;
    const maxZ = Math.max(pz, pz + dz) + half.z + 1;
    this.candidates(minX, minZ, maxX, maxZ, this.scratch);

    let bestT = 1;
    let hit: SweepHit | null = null;
    for (let i = 0; i < this.scratch.length; i++) {
      const bi = this.scratch[i];
      const b = this.brushes[bi];
      // Minkowski expansion: box vs brush becomes point (ray) vs expanded brush.
      const eMinX = b.min[0] - half.x;
      const eMinY = b.min[1] - half.y;
      const eMinZ = b.min[2] - half.z;
      const eMaxX = b.max[0] + half.x;
      const eMaxY = b.max[1] + half.y;
      const eMaxZ = b.max[2] + half.z;

      let tNear = -Infinity;
      let tFar = Infinity;
      let nx = 0;
      let ny = 0;
      let nz = 0;

      // X slab
      if (Math.abs(dx) < EPS) {
        if (px < eMinX || px > eMaxX) continue;
      } else {
        let t1 = (eMinX - px) / dx;
        let t2 = (eMaxX - px) / dx;
        let sign = -1;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
          sign = 1;
        }
        if (t1 > tNear) {
          tNear = t1;
          nx = sign;
          ny = 0;
          nz = 0;
        }
        if (t2 < tFar) tFar = t2;
      }
      // Y slab
      if (Math.abs(dy) < EPS) {
        if (py < eMinY || py > eMaxY) continue;
      } else {
        let t1 = (eMinY - py) / dy;
        let t2 = (eMaxY - py) / dy;
        let sign = -1;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
          sign = 1;
        }
        if (t1 > tNear) {
          tNear = t1;
          nx = 0;
          ny = sign;
          nz = 0;
        }
        if (t2 < tFar) tFar = t2;
      }
      // Z slab
      if (Math.abs(dz) < EPS) {
        if (pz < eMinZ || pz > eMaxZ) continue;
      } else {
        let t1 = (eMinZ - pz) / dz;
        let t2 = (eMaxZ - pz) / dz;
        let sign = -1;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
          sign = 1;
        }
        if (t1 > tNear) {
          tNear = t1;
          nx = 0;
          ny = 0;
          nz = sign;
        }
        if (t2 < tFar) tFar = t2;
      }

      if (tNear > tFar || tFar < 0 || tNear > 1) continue;
      if (tNear < 0) continue; // already overlapping; depenetration handles it
      if (tNear < bestT) {
        bestT = tNear;
        hit = { t: tNear, nx, ny, nz, brush: bi };
      }
    }
    return hit;
  }

  /** True if the box at this position overlaps any solid brush. */
  boxOverlaps(px: number, py: number, pz: number, half: Vec3): boolean {
    this.candidates(px - half.x, pz - half.z, px + half.x, pz + half.z, this.scratch);
    for (let i = 0; i < this.scratch.length; i++) {
      const b = this.brushes[this.scratch[i]];
      if (
        px + half.x > b.min[0] + SKIN &&
        px - half.x < b.max[0] - SKIN &&
        py + half.y > b.min[1] + SKIN &&
        py - half.y < b.max[1] - SKIN &&
        pz + half.z > b.min[2] + SKIN &&
        pz - half.z < b.max[2] - SKIN
      ) {
        return true;
      }
    }
    return false;
  }

  /** Ray against the level geometry. Returns the nearest hit within maxDist. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RayHit | null {
    const ex = ox + dx * maxDist;
    const ez = oz + dz * maxDist;
    this.candidates(Math.min(ox, ex) - 1, Math.min(oz, ez) - 1, Math.max(ox, ex) + 1, Math.max(oz, ez) + 1, this.scratch);

    let bestT = maxDist;
    let hit: RayHit | null = null;
    for (let i = 0; i < this.scratch.length; i++) {
      const bi = this.scratch[i];
      const b = this.brushes[bi];
      let tNear = -Infinity;
      let tFar = Infinity;
      let nx = 0;
      let ny = 0;
      let nz = 0;

      const o = [ox, oy, oz];
      const d = [dx, dy, dz];
      let miss = false;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < EPS) {
          if (o[a] < b.min[a] || o[a] > b.max[a]) {
            miss = true;
            break;
          }
          continue;
        }
        let t1 = (b.min[a] - o[a]) / d[a];
        let t2 = (b.max[a] - o[a]) / d[a];
        let sign = -1;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
          sign = 1;
        }
        if (t1 > tNear) {
          tNear = t1;
          nx = a === 0 ? sign : 0;
          ny = a === 1 ? sign : 0;
          nz = a === 2 ? sign : 0;
        }
        if (t2 < tFar) tFar = t2;
      }
      if (miss || tNear > tFar || tFar < 0) continue;
      const t = tNear < 0 ? 0 : tNear;
      if (t < bestT) {
        bestT = t;
        hit = { t, nx, ny, nz, brush: bi };
      }
    }
    return hit;
  }
}
