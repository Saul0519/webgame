import * as THREE from 'three';
import { Surface } from '@webgame/shared';

const MAX_SPARKS = 600;
const MAX_DEBRIS = 600;
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

interface ParticleState {
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
  drag: number;
  gravity: number;
  size: number;
}

/** A pooled point-sprite emitter. Sparks glow (additive); dust and blood do not. */
class ParticleSystem {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly colour: Float32Array;
  private readonly state: ParticleState[] = [];
  private readonly capacity: number;
  private next = 0;

  constructor(capacity: number, blending: THREE.Blending) {
    this.capacity = capacity;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.colour = new Float32Array(capacity * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('aColour', new THREE.BufferAttribute(this.colour, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: PARTICLE_VERT,
        fragmentShader: PARTICLE_FRAG,
        transparent: true,
        depthWrite: false,
        blending,
      }),
    );
    this.points.frustumCulled = false;
    for (let i = 0; i < capacity; i++) {
      this.state.push({ life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0, drag: 2, gravity: 9, size: 1 });
    }
  }

  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    colour: THREE.Color, size: number, life: number, gravity: number, drag: number,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.colour[i * 3] = colour.r;
    this.colour[i * 3 + 1] = colour.g;
    this.colour[i * 3 + 2] = colour.b;
    this.size[i] = size;
    this.alpha[i] = 1;
    const s = this.state[i];
    s.life = life;
    s.maxLife = life;
    s.vx = vx;
    s.vy = vy;
    s.vz = vz;
    s.size = size;
    s.gravity = gravity;
    s.drag = drag;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.state[i];
      if (s.life <= 0) {
        if (this.alpha[i] !== 0) {
          this.alpha[i] = 0;
          dirty = true;
        }
        continue;
      }
      dirty = true;
      s.life -= dt;
      const k = Math.max(0, s.life / s.maxLife);
      s.vy -= s.gravity * dt;
      const drag = Math.max(0, 1 - s.drag * dt);
      s.vx *= drag;
      s.vy *= drag;
      s.vz *= drag;
      this.pos[i * 3] += s.vx * dt;
      this.pos[i * 3 + 1] += s.vy * dt;
      this.pos[i * 3 + 2] += s.vz * dt;
      this.alpha[i] = k * k;
      this.size[i] = s.size * (0.5 + k * 0.5);
    }
    if (!dirty) return;
    const g = this.points.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aColour') as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Impact sparks, bullet holes, tracers and blood — all pooled, no allocations
 * in the hot path. */
export class Effects {
  private readonly sparks = new ParticleSystem(MAX_SPARKS, THREE.AdditiveBlending);
  private readonly debris = new ParticleSystem(MAX_DEBRIS, THREE.NormalBlending);

  private readonly tracerMesh: THREE.InstancedMesh;
  private readonly tracers: { life: number; maxLife: number; from: THREE.Vector3; to: THREE.Vector3 }[] = [];
  private tracerNext = 0;

  private readonly decalMesh: THREE.InstancedMesh;
  private decalNext = 0;

  // Scratch objects: the update loop runs every frame and must not allocate.
  private readonly dummy = new THREE.Object3D();
  private readonly vCam = new THREE.Vector3();
  private readonly vDir = new THREE.Vector3();
  private readonly vToCam = new THREE.Vector3();
  private readonly vSide = new THREE.Vector3();
  private readonly vFace = new THREE.Vector3();
  private readonly mBasis = new THREE.Matrix4();
  private readonly bloodColour = new THREE.Color(0.42, 0.03, 0.04);

  constructor(scene: THREE.Scene) {
    scene.add(this.debris.points);
    scene.add(this.sparks.points);

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
    scene.add(this.tracerMesh);
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracers.push({ life: 0, maxLife: 0.07, from: new THREE.Vector3(), to: new THREE.Vector3() });
      this.park(this.tracerMesh, i);
    }

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
    for (let i = 0; i < MAX_DECALS; i++) this.park(this.decalMesh, i);
  }

  private park(mesh: THREE.InstancedMesh, i: number): void {
    const d = this.dummy;
    d.position.set(0, -1000, 0);
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(0.0001);
    d.updateMatrix();
    mesh.setMatrixAt(i, d.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  spawnImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, surf: number): void {
    const cfg = SURFACE_SPARK[surf] ?? SURFACE_SPARK[Surface.Concrete];
    const count = 7 + Math.floor(Math.random() * 5);
    for (let i = 0; i < count; i++) {
      const spread = 0.85;
      const vx = nx * 2.6 + (Math.random() - 0.5) * spread * 5;
      const vy = ny * 2.6 + (Math.random() - 0.5) * spread * 5 + 1.2;
      const vz = nz * 2.6 + (Math.random() - 0.5) * spread * 5;
      if (Math.random() < cfg.spark) {
        this.sparks.emit(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02, vx, vy, vz,
          cfg.colour, 0.055, 0.22 + Math.random() * 0.2, 16, 1.5);
      } else {
        this.debris.emit(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02, vx * 0.5, vy * 0.5, vz * 0.5,
          cfg.dust, 0.13, 0.45 + Math.random() * 0.35, 2.4, 4.5);
      }
    }
    this.addDecal(x, y, z, nx, ny, nz);
  }

  /** `dx/dy/dz` points from the shooter toward the victim, so spray goes with the round. */
  spawnBlood(x: number, y: number, z: number, dx: number, dy: number, dz: number, heavy: boolean): void {
    const n = heavy ? 24 : 11;
    for (let i = 0; i < n; i++) {
      this.debris.emit(
        x, y, z,
        dx * 2.4 + (Math.random() - 0.5) * 3.0,
        dy * 2.4 + (Math.random() - 0.5) * 3.0 + 1.5,
        dz * 2.4 + (Math.random() - 0.5) * 3.0,
        this.bloodColour,
        0.07 + Math.random() * 0.06,
        0.4 + Math.random() * 0.3,
        11,
        2.2,
      );
    }
  }

  spawnTracer(fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number): void {
    const t = this.tracers[this.tracerNext];
    this.tracerNext = (this.tracerNext + 1) % MAX_TRACERS;
    t.from.set(fromX, fromY, fromZ);
    t.to.set(toX, toY, toZ);
    t.life = t.maxLife;
  }

  private addDecal(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    const i = this.decalNext;
    this.decalNext = (this.decalNext + 1) % MAX_DECALS;
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
    this.sparks.update(dt);
    this.debris.update(dt);

    camera.getWorldPosition(this.vCam);
    let dirty = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = this.tracers[i];
      if (t.life <= 0) continue;
      dirty = true;
      t.life -= dt;
      const k = Math.max(0, t.life / t.maxLife);
      const d = this.dummy;
      this.vDir.subVectors(t.to, t.from);
      const len = this.vDir.length() || 0.001;
      this.vDir.multiplyScalar(1 / len);
      this.vToCam.subVectors(this.vCam, t.from).normalize();
      this.vSide.crossVectors(this.vDir, this.vToCam);
      if (this.vSide.lengthSq() < 1e-8) this.vSide.set(1, 0, 0);
      this.vSide.normalize();
      this.vFace.crossVectors(this.vSide, this.vDir).normalize();
      this.mBasis.makeBasis(this.vSide, this.vDir, this.vFace);
      d.position.copy(t.from);
      d.quaternion.setFromRotationMatrix(this.mBasis);
      d.scale.set(0.035 * k + 0.008, len, 1);
      d.updateMatrix();
      this.tracerMesh.setMatrixAt(i, d.matrix);
      if (t.life <= 0) this.park(this.tracerMesh, i);
    }
    if (dirty) this.tracerMesh.instanceMatrix.needsUpdate = true;
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
