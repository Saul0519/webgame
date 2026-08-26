import { CollisionWorld } from './collision.js';
import { PLAYER_HEIGHT, PLAYER_RADIUS, STEP_HEIGHT } from './constants.js';
import type { GameMap } from './map.js';

/**
 * A very small navigation graph, generated from the collision geometry rather
 * than authored by hand. Columns are sampled on a grid; every walkable surface
 * found in a column (ground, ramps, the centre platform, the catwalk) becomes a
 * node, and neighbouring nodes are linked when a walking probe can actually get
 * between them. That keeps bots honest about stairs, ledges and drops without
 * anyone maintaining a hand-placed waypoint list.
 */

const CELL = 3;
/** Clearance a node needs above the floor to be stood in. */
const HEADROOM = PLAYER_HEIGHT + 0.1;
/** Nodes further apart vertically than this are never linked directly. */
const MAX_STEP_UP = STEP_HEIGHT;
/** Bots will happily drop this far; more than this and the link is one-way. */
const MAX_DROP = 4.0;

export interface NavNode {
  x: number;
  y: number;
  z: number;
  links: number[];
}

export class NavGraph {
  readonly nodes: NavNode[] = [];
  private readonly world: CollisionWorld;
  private readonly cellIndex = new Map<number, number[]>();
  private readonly gx0: number;
  private readonly gz0: number;
  private readonly gw: number;

  constructor(world: CollisionWorld, map: GameMap) {
    this.world = world;
    const min = map.bounds.min;
    const max = map.bounds.max;
    this.gx0 = Math.floor(min[0] / CELL);
    this.gz0 = Math.floor(min[2] / CELL);
    this.gw = Math.ceil(max[0] / CELL) - this.gx0 + 1;
    const gh = Math.ceil(max[2] / CELL) - this.gz0 + 1;

    const ceiling = max[1];
    for (let cz = 0; cz < gh; cz++) {
      for (let cx = 0; cx < this.gw; cx++) {
        const x = (cx + this.gx0) * CELL + CELL / 2;
        const z = (cz + this.gz0) * CELL + CELL / 2;
        const key = cz * this.gw + cx;
        const column: number[] = [];
        for (const y of this.floorsInColumn(x, z, ceiling, min[1])) {
          column.push(this.nodes.length);
          this.nodes.push({ x, y, z, links: [] });
        }
        if (column.length > 0) this.cellIndex.set(key, column);
      }
    }

    this.link();
  }

  /** Every standable surface height in one column, top down. */
  private floorsInColumn(x: number, z: number, top: number, bottom: number): number[] {
    const out: number[] = [];
    let from = top;
    for (let guard = 0; guard < 8; guard++) {
      const hit = this.world.raycast(x, from, z, 0, -1, 0, from - bottom);
      if (!hit) break;
      const y = from - hit.t;
      if (hit.ny > 0.7 && this.standable(x, y, z)) out.push(y);
      from = y - 0.35;
      if (from <= bottom) break;
    }
    return out;
  }

  private standable(x: number, y: number, z: number): boolean {
    const half = { x: PLAYER_RADIUS * 0.95, y: HEADROOM / 2, z: PLAYER_RADIUS * 0.95 };
    return !this.world.boxOverlaps(x, y + half.y, z, half);
  }

  private nodeAt(cx: number, cz: number): number[] {
    return this.cellIndex.get(cz * this.gw + cx) ?? [];
  }

  private link(): void {
    const gh = Math.ceil(this.cellIndex.size / Math.max(1, this.gw)) + this.gw;
    for (const [key, column] of this.cellIndex) {
      const cx = key % this.gw;
      const cz = Math.floor(key / this.gw);
      for (const [ox, oz] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [1, -1],
      ]) {
        const other = this.nodeAt(cx + ox, cz + oz);
        if (other.length === 0) continue;
        for (const a of column) {
          for (const b of other) {
            const na = this.nodes[a];
            const nb = this.nodes[b];
            const dy = nb.y - na.y;
            if (dy > MAX_STEP_UP && dy > 0) {
              // Only a drop is allowed in the downhill direction.
              if (-dy > MAX_DROP) continue;
            }
            if (Math.abs(dy) > MAX_DROP) continue;
            if (!this.walkable(na, nb)) continue;
            na.links.push(b);
            nb.links.push(a);
          }
        }
      }
    }
    void gh;
  }

  /**
   * Walk a probe along the segment, following the floor. Rejects the link if
   * the floor disappears, jumps up more than a step, or the body would clip.
   */
  private walkable(a: NavNode, b: NavNode): boolean {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(2, Math.ceil(dist / 0.6));
    let prevY = a.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const searchTop = prevY + MAX_STEP_UP + 0.4;
      const hit = this.world.raycast(x, searchTop, z, 0, -1, 0, MAX_DROP + MAX_STEP_UP + 1);
      if (!hit || hit.ny < 0.7) return false;
      const y = searchTop - hit.t;
      if (y - prevY > MAX_STEP_UP + 1e-3) return false;
      if (prevY - y > MAX_DROP) return false;
      if (!this.standable(x, y, z)) return false;
      prevY = y;
    }
    return Math.abs(prevY - b.y) < MAX_STEP_UP + 0.2;
  }

  /** Nearest node to a world position, preferring ones at a similar height. */
  nearest(x: number, y: number, z: number): number {
    let best = -1;
    let bestScore = Infinity;
    const cx = Math.floor(x / CELL) - this.gx0;
    const cz = Math.floor(z / CELL) - this.gz0;
    for (let r = 0; r <= 3 && best < 0; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (const idx of this.nodeAt(cx + dx, cz + dz)) {
            const n = this.nodes[idx];
            const score = (n.x - x) ** 2 + (n.z - z) ** 2 + (n.y - y) ** 2 * 4;
            if (score < bestScore) {
              bestScore = score;
              best = idx;
            }
          }
        }
      }
    }
    return best;
  }

  /** Breadth-first path between node indices; returns [] when unreachable. */
  path(from: number, to: number, out: number[]): number[] {
    out.length = 0;
    if (from < 0 || to < 0) return out;
    if (from === to) {
      out.push(to);
      return out;
    }
    const prev = new Int32Array(this.nodes.length).fill(-1);
    const seen = new Uint8Array(this.nodes.length);
    const queue = [from];
    seen[from] = 1;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      for (const nxt of this.nodes[cur].links) {
        if (seen[nxt]) continue;
        seen[nxt] = 1;
        prev[nxt] = cur;
        if (nxt === to) {
          let n = to;
          while (n !== -1) {
            out.push(n);
            n = prev[n];
          }
          out.reverse();
          return out;
        }
        queue.push(nxt);
      }
    }
    return out;
  }
}
