import * as THREE from 'three';
import { Surface, type Brush, type GameMap } from '@webgame/shared';
import type { SurfaceMaterials } from './Materials.js';

/** Six faces of a box, as (normal axis, sign) with the UV axes to project on. */
const FACES: { n: [number, number, number]; u: 0 | 1 | 2; v: 0 | 1 | 2; corners: number[][] }[] = [
  // +X
  { n: [1, 0, 0], u: 2, v: 1, corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  // -X
  { n: [-1, 0, 0], u: 2, v: 1, corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  // +Y
  { n: [0, 1, 0], u: 0, v: 2, corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  // -Y
  { n: [0, -1, 0], u: 0, v: 2, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  // +Z
  { n: [0, 0, 1], u: 0, v: 1, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  // -Z
  { n: [0, 0, -1], u: 0, v: 1, corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

interface Buffers {
  pos: number[];
  nor: number[];
  uv: number[];
  idx: number[];
}

function emptyBuffers(): Buffers {
  return { pos: [], nor: [], uv: [], idx: [] };
}

function pushBrush(b: Buffers, brush: Brush): void {
  const [x0, y0, z0] = brush.min;
  const [x1, y1, z1] = brush.max;
  const size = [x1 - x0, y1 - y0, z1 - z0];
  const scale = brush.uvScale ?? 0.5;

  for (const face of FACES) {
    const base = b.pos.length / 3;
    for (const c of face.corners) {
      const px = x0 + c[0] * size[0];
      const py = y0 + c[1] * size[1];
      const pz = z0 + c[2] * size[2];
      b.pos.push(px, py, pz);
      b.nor.push(face.n[0], face.n[1], face.n[2]);
      const world = [px, py, pz];
      b.uv.push(world[face.u] * scale, world[face.v] * scale);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function toGeometry(b: Buffers): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

export interface BuiltLevel {
  group: THREE.Group;
  emissiveMeshes: THREE.Mesh[];
}

/** Merge every brush into one mesh per surface: ~5 draw calls for the arena. */
export function buildLevel(map: GameMap, materials: SurfaceMaterials): BuiltLevel {
  const group = new THREE.Group();
  group.name = 'level';
  const bySurface = new Map<Surface, Buffers>();

  for (const brush of map.brushes) {
    let buf = bySurface.get(brush.surf);
    if (!buf) {
      buf = emptyBuffers();
      bySurface.set(brush.surf, buf);
    }
    pushBrush(buf, brush);
  }

  const emissiveMeshes: THREE.Mesh[] = [];
  for (const [surf, buf] of bySurface) {
    const mat = materials.get(surf) ?? materials.get(Surface.Concrete)!;
    const mesh = new THREE.Mesh(toGeometry(buf), mat);
    mesh.name = `surface_${surf}`;
    if (surf === Surface.Emissive) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      emissiveMeshes.push(mesh);
    } else {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }

  return { group, emissiveMeshes };
}
