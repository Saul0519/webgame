import * as THREE from 'three';
import { Surface } from '@webgame/shared';

const MAX_PARTICLES = 900;
const MAX_TRACERS = 48;
const MAX_DECALS = 160;

const SURFACE_SPARK: Record<number, { colour: THREE.Color; spark: number; dust: THREE.Color }> = {
  [Surface.Concrete]: { colour: new THREE.Color(0xd8cfc0), spark: 0.15, dust: new THREE.Color(0x9c948a) },
  [Surface.Metal]: { colour: new THREE.Color(0xffd08a), spark: 1.0, dust: new THREE.Color(0x8d949c) },
  [Surface.Crate]: { colour: new THREE.Color(0xd8a05a), spark: 0.3, dust: new THREE.Color(0x8a6438) },
  [Surface.Grate]: { colour: new THREE.Color(0xffc978), spark: 0.9, dust: new THREE.Color(0x6e747a) },
  [Surface.Emissive]: { colour: new THREE.Color(0x9fe8ff), spark: 0.8, dust: new THREE.Color(0x6ec0d8) },
};

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColour;
varying float vAlpha;
varying vec3 vColour;
void main() {
  vAlpha = aAlpha;
  vColour = aColour;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (260.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColour;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  float falloff = smoothstep(0.25, 0.0, r);
  gl_FragColor = vec4(vColour * falloff, vAlpha * falloff);
}
`;

interface Particle {
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
  drag: number;
  gravity: number;
  size: number;
}

/** Impact sparks, bullet holes, tracers and blood — all pooled, no allocations
 * in the hot path. */
export class Effects {
  private readonly scene: THREE.Scene;

  private readonly particles: THREE.Points;
  private readonly pPos: Float32Array;
  private readonly pSize: Float32Array;
  private readonly pAlpha: Float32Array;
  private readonly pColour: Float32Array;
  private readonly pState: Particle[] = [];
  private pNext = 0;

  private readonly tracerMesh: THREE.InstancedMesh;
  private readonly tracers: { life: number; maxLife: number; from: THREE.Vector3; to: THREE.Vector3 }[] = [];
  private tracerNext = 0;
  private readonly dummy = new THREE.Object3D();

  private readonly decalMesh: THREE.InstancedMesh;
  private readonly decalAge: number[] = [];
  private decalNext = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // --- particles ---
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    this.pAlpha = new Float32Array(MAX_PARTICLES);
    this.pColour = new Float32Array(MAX_PARTICLES * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.pAlpha, 1));
    geo.setAttribute('aColour', new THREE.BufferAttribute(this.pColour, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);
    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.particles = new THREE.Points(geo, mat);
    this.particles.frustumCulled = false;
    scene.add(this.particles);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pState.push({ life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0, drag: 2, gravity: 9, size: 1 });
    }

    // --- tracers ---
    const tracerGeo = new THREE.PlaneGeometry(1, 1);
    tracerGeo.translate(0, 0.5, 0); // pivot at the base so scaling stretches forward
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffdca8,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.tracerMesh = new THREE.InstancedMesh(tracerGeo, tracerMat, MAX_TRACERS);
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.count = MAX_TRACERS;
    scene.add(this.tracerMesh);
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracers.push({ life: 0, maxLife: 0.07, from: new THREE.Vector3(), to: new THREE.Vector3() });
      this.dummy.position.set(0, -1000, 0);
      this.dummy.scale.setScalar(0.0001);
      this.dummy.updateMatrix();
      this.tracerMesh.setMatrixAt(i, this.dummy.matrix);
    }

    // --- bullet holes ---
    const decalGeo = new THREE.PlaneGeometry(1, 1);
    const decalMat = new THREE.MeshBasicMaterial({
      map: makeHoleTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      opacity: 0.85,
    });
    this.decalMesh = new THREE.InstancedMesh(decalGeo, decalMat, MAX_DECALS);
    this.decalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decalMesh.frustumCulled = false;
    scene.add(this.decalMesh);
    for (let i = 0; i < MAX_DECALS; i++) {
      this.decalAge.push(Infinity);
      this.dummy.position.set(0, -1000, 0);
      this.dummy.scale.setScalar(0.0001);
      this.dummy.updateMatrix();
      this.decalMesh.setMatrixAt(i, this.dummy.matrix);
    }
  }

  private emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    colour: THREE.Color,
    size: number,
    life: number,
    gravity: number,
    drag: number,
  ): void {
    const i = this.pNext;
    this.pNext = (this.pNext + 1) % MAX_PARTICLES;
    this.pPos[i * 3] = x;
    this.pPos[i * 3 + 1] = y;
    this.pPos[i * 3 + 2] = z;
    this.pColour[i * 3] = colour.r;
    this.pColour[i * 3 + 1] = colour.g;
    this.pColour[i * 3 + 2] = colour.b;
    this.pSize[i] = size;
    this.pAlpha[i] = 1;
    const s = this.pState[i];
    s.life = life;
    s.maxLife = life;
    s.vx = vx;
    s.vy = vy;
    s.vz = vz;
    s.size = size;
    s.gravity = gravity;
    s.drag = drag;
  }

  spawnImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, surf: number): void {
    const cfg = SURFACE_SPARK[surf] ?? SURFACE_SPARK[Surface.Concrete];
    const count = 7 + Math.floor(Math.random() * 5);
    for (let i = 0; i < count; i++) {
      const spread = 0.85;
      const vx = nx * 2.6 + (Math.random() - 0.5) * spread * 5;
      const vy = ny * 2.6 + (Math.random() - 0.5) * spread * 5 + 1.2;
      const vz = nz * 2.6 + (Math.random() - 0.5) * spread * 5;
      const isSpark = Math.random() < cfg.spark;
      this.emit(
        x + nx * 0.02,
        y + ny * 0.02,
        z + nz * 0.02,
        vx,
        vy,
        vz,
        isSpark ? cfg.colour : cfg.dust,
        isSpark ? 0.055 : 0.11,
        isSpark ? 0.22 + Math.random() * 0.2 : 0.45 + Math.random() * 0.35,
        isSpark ? 16 : 2.4,
        isSpark ? 1.5 : 4.5,
      );
    }
    this.addDecal(x, y, z, nx, ny, nz);
  }

  spawnBlood(x: number, y: number, z: number, dx: number, dy: number, dz: number, heavy: boolean): void {
    const colour = new THREE.Color(0.55, 0.05, 0.06);
    const n = heavy ? 22 : 10;
    for (let i = 0; i < n; i++) {
      this.emit(
        x,
        y,
        z,
        -dx * 2 + (Math.random() - 0.5) * 3.2,
        -dy * 2 + (Math.random() - 0.5) * 3.2 + 1.4,
        -dz * 2 + (Math.random() - 0.5) * 3.2,
        colour,
        0.07 + Math.random() * 0.06,
        0.4 + Math.random() * 0.3,
        11,
        2.2,
      );
    }
  }

  spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const t = this.tracers[this.tracerNext];
    this.tracerNext = (this.tracerNext + 1) % MAX_TRACERS;
    t.from.copy(from);
    t.to.copy(to);
    t.life = t.maxLife;
  }

  private addDecal(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    const i = this.decalNext;
    this.decalNext = (this.decalNext + 1) % MAX_DECALS;
    this.decalAge[i] = 0;
    const d = this.dummy;
    d.position.set(x + nx * 0.012, y + ny * 0.012, z + nz * 0.012);
    d.lookAt(d.position.x + nx, d.position.y + ny, d.position.z + nz);
    d.rotateZ(Math.random() * Math.PI * 2);
    d.scale.setScalar(0.13 + Math.random() * 0.06);
    d.updateMatrix();
    this.decalMesh.setMatrixAt(i, d.matrix);
    this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number, camera: THREE.Camera): void {
    // Particles
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const s = this.pState[i];
      if (s.life <= 0) {
        if (this.pAlpha[i] !== 0) this.pAlpha[i] = 0;
        continue;
      }
      s.life -= dt;
      const k = Math.max(0, s.life / s.maxLife);
      s.vy -= s.gravity * dt;
      const drag = Math.max(0, 1 - s.drag * dt);
      s.vx *= drag;
      s.vy *= drag;
      s.vz *= drag;
      this.pPos[i * 3] += s.vx * dt;
      this.pPos[i * 3 + 1] += s.vy * dt;
      this.pPos[i * 3 + 2] += s.vz * dt;
      this.pAlpha[i] = k * k;
      this.pSize[i] = s.size * (0.5 + k * 0.5);
    }
    const g = this.particles.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aColour') as THREE.BufferAttribute).needsUpdate = true;

    // Tracers: a thin billboarded quad stretched from muzzle to impact.
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    let anyTracer = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = this.tracers[i];
      const d = this.dummy;
      if (t.life <= 0) {
        d.position.set(0, -1000, 0);
        d.scale.setScalar(0.0001);
        d.rotation.set(0, 0, 0);
        d.updateMatrix();
        this.tracerMesh.setMatrixAt(i, d.matrix);
        continue;
      }
      anyTracer = true;
      t.life -= dt;
      const k = Math.max(0, t.life / t.maxLife);
      const dir = new THREE.Vector3().subVectors(t.to, t.from);
      const len = dir.length();
      dir.normalize();
      const toCam = new THREE.Vector3().subVectors(camPos, t.from).normalize();
      const side = new THREE.Vector3().crossVectors(dir, toCam).normalize();
      const face = new THREE.Vector3().crossVectors(side, dir).normalize();
      const m = new THREE.Matrix4().makeBasis(side, dir, face);
      d.position.copy(t.from);
      d.quaternion.setFromRotationMatrix(m);
      d.scale.set(0.035 * k + 0.008, len, 1);
      d.updateMatrix();
      this.tracerMesh.setMatrixAt(i, d.matrix);
    }
    if (anyTracer || this.tracerMesh.instanceMatrix.needsUpdate) {
      this.tracerMesh.instanceMatrix.needsUpdate = true;
    }

    // Fade old decals out by shrinking them (cheap, avoids per-instance alpha).
    for (let i = 0; i < MAX_DECALS; i++) {
      if (this.decalAge[i] === Infinity) continue;
      this.decalAge[i] += dt;
    }
  }
}

function makeHoleTexture(): THREE.Texture {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, n, n);
  const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  g.addColorStop(0, 'rgba(8,8,10,0.98)');
  g.addColorStop(0.32, 'rgba(16,16,20,0.85)');
  g.addColorStop(0.6, 'rgba(40,38,36,0.35)');
  g.addColorStop(1, 'rgba(40,38,36,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(n / 2, n / 2, n / 2, 0, Math.PI * 2);
  ctx.fill();
  // Radial cracks so holes do not read as perfect circles.
  ctx.strokeStyle = 'rgba(20,20,24,0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2;
    const r0 = n * 0.16;
    const r1 = n * (0.3 + Math.random() * 0.2);
    ctx.beginPath();
    ctx.moveTo(n / 2 + Math.cos(a) * r0, n / 2 + Math.sin(a) * r0);
    ctx.lineTo(n / 2 + Math.cos(a) * r1, n / 2 + Math.sin(a) * r1);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
