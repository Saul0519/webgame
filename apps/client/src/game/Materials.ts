import * as THREE from 'three';
import { Surface } from '@webgame/shared';

/* Everything here is generated at runtime: the repo ships no texture files, and
 * procedural maps keep the arena looking like built architecture rather than
 * flat-shaded blocks. */

function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tiling value noise on a period-`period` lattice. */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const wrap = (n: number) => ((n % period) + period) % period;
  const a = hash2(wrap(xi), wrap(yi), seed);
  const b = hash2(wrap(xi + 1), wrap(yi), seed);
  const c = hash2(wrap(xi), wrap(yi + 1), seed);
  const d = hash2(wrap(xi + 1), wrap(yi + 1), seed);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x: number, y: number, octaves: number, basePeriod: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, freq, seed + o * 71) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const SIZE = 256;

interface SurfaceRecipe {
  /** height/roughness/albedo generator; uv in 0..1, returns [r,g,b,height]. */
  shade: (u: number, v: number) => [number, number, number, number];
  metalness: number;
  roughBase: number;
  roughVar: number;
  normalScale: number;
  emissive?: number;
  emissiveIntensity?: number;
}

function grid(u: number, v: number, cells: number, width: number): number {
  const fu = Math.abs(((u * cells) % 1) - 0.5) * 2;
  const fv = Math.abs(((v * cells) % 1) - 0.5) * 2;
  const edge = Math.max(fu, fv);
  return edge > 1 - width ? (edge - (1 - width)) / width : 0;
}

const RECIPES: Partial<Record<Surface, SurfaceRecipe>> = {
  [Surface.Concrete]: {
    shade: (u, v) => {
      const n = fbm(u * 8, v * 8, 5, 4, 11);
      const speck = valueNoise(u * 220, v * 220, 220, 5) > 0.93 ? 0.14 : 0;
      const seam = grid(u, v, 2, 0.02) * 0.5;
      const base = 0.30 + n * 0.16 + speck - seam * 0.5;
      return [base * 1.0, base * 1.0, base * 1.03, n * 0.7 - seam];
    },
    metalness: 0.02,
    roughBase: 0.86,
    roughVar: 0.14,
    normalScale: 0.7,
  },
  [Surface.Metal]: {
    shade: (u, v) => {
      const brush = fbm(u * 60, v * 3, 4, 8, 23);
      const panel = grid(u, v, 4, 0.012);
      const rivet = valueNoise(u * 32, v * 32, 32, 9) > 0.97 ? 0.2 : 0;
      const base = 0.42 + brush * 0.14 - panel * 0.28 + rivet;
      return [base * 0.94, base * 0.98, base * 1.06, brush * 0.5 - panel * 1.2 + rivet];
    },
    metalness: 0.92,
    roughBase: 0.34,
    roughVar: 0.24,
    normalScale: 1.0,
  },
  [Surface.Crate]: {
    shade: (u, v) => {
      const wear = fbm(u * 14, v * 14, 4, 6, 37);
      const frame = grid(u, v, 1, 0.08);
      const rib = Math.abs(((v * 6) % 1) - 0.5) < 0.08 ? 0.12 : 0;
      const worn = wear > 0.72 ? 0.28 : 0;
      const r = 0.52 + frame * 0.1 - worn * 0.25 + rib;
      const g = 0.29 + frame * 0.08 - worn * 0.12 + rib;
      const b = 0.13 + frame * 0.05 + worn * 0.05 + rib;
      return [r, g, b, frame * 1.2 + rib * 2 + wear * 0.3];
    },
    metalness: 0.35,
    roughBase: 0.62,
    roughVar: 0.3,
    normalScale: 1.2,
  },
  [Surface.Grate]: {
    shade: (u, v) => {
      const holes = grid(u, v, 16, 0.35);
      const dirt = fbm(u * 10, v * 10, 3, 5, 51);
      const base = 0.14 + holes * 0.3 + dirt * 0.06;
      return [base, base * 1.02, base * 1.08, holes * 2 - 1];
    },
    metalness: 0.85,
    roughBase: 0.52,
    roughVar: 0.16,
    normalScale: 1.0,
  },
  [Surface.Emissive]: {
    shade: () => [0.75, 0.93, 1.0, 0],
    metalness: 0.0,
    roughBase: 0.4,
    roughVar: 0,
    normalScale: 0,
    emissive: 0x63d8ff,
    emissiveIntensity: 0.6,
  },
};

function buildMaps(recipe: SurfaceRecipe): { map: THREE.DataTexture; rough: THREE.DataTexture; normal: THREE.DataTexture } {
  const n = SIZE;
  const albedo = new Uint8Array(n * n * 4);
  const rough = new Uint8Array(n * n * 4);
  const height = new Float32Array(n * n);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const [r, g, b, h] = recipe.shade(x / n, y / n);
      albedo[i * 4] = Math.max(0, Math.min(255, r * 255));
      albedo[i * 4 + 1] = Math.max(0, Math.min(255, g * 255));
      albedo[i * 4 + 2] = Math.max(0, Math.min(255, b * 255));
      albedo[i * 4 + 3] = 255;
      height[i] = h;
      const rr = recipe.roughBase + (h * 0.5 + 0.5 - 0.5) * recipe.roughVar;
      const rv = Math.max(0, Math.min(255, rr * 255));
      rough[i * 4] = 0;
      rough[i * 4 + 1] = rv; // green = roughness
      rough[i * 4 + 2] = 0;
      rough[i * 4 + 3] = 255;
    }
  }

  // Sobel the height field into a tangent-space normal map.
  const normal = new Uint8Array(n * n * 4);
  const at = (x: number, y: number) => height[((y + n) % n) * n + ((x + n) % n)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      const s = recipe.normalScale;
      let nx = dx * s;
      let ny = dy * s;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const i = (y * n + x) * 4;
      normal[i] = (nx * 0.5 + 0.5) * 255;
      normal[i + 1] = (ny * 0.5 + 0.5) * 255;
      normal[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;
    }
  }

  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };

  return { map: mk(albedo, true), rough: mk(rough, false), normal: mk(normal, false) };
}

export type SurfaceMaterials = Map<Surface, THREE.MeshStandardMaterial>;

export function buildSurfaceMaterials(): SurfaceMaterials {
  const out: SurfaceMaterials = new Map();
  for (const key of Object.keys(RECIPES)) {
    const surf = Number(key) as Surface;
    const recipe = RECIPES[surf]!;
    const { map, rough, normal } = buildMaps(recipe);
    const mat = new THREE.MeshStandardMaterial({
      map,
      roughnessMap: rough,
      normalMap: recipe.normalScale > 0 ? normal : null,
      normalScale: new THREE.Vector2(1, 1),
      metalness: recipe.metalness,
      roughness: 1.0,
      envMapIntensity: 1.0,
    });
    if (recipe.emissive !== undefined) {
      mat.emissive = new THREE.Color(recipe.emissive);
      mat.emissiveIntensity = recipe.emissiveIntensity ?? 2;
      mat.toneMapped = true;
    }
    out.set(surf, mat);
  }
  // Surfaces without a recipe fall back to concrete.
  const fallback = out.get(Surface.Concrete)!;
  for (const s of [Surface.Rubber, Surface.Sand]) {
    if (!out.has(s)) out.set(s, fallback);
  }
  return out;
}
