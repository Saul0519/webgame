import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { WeaponId } from '@webgame/shared';

const gunMetal = new THREE.MeshStandardMaterial({ color: 0x30353d, roughness: 0.36, metalness: 0.95 });
const gunDark = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.55, metalness: 0.75 });
const gunPolymer = new THREE.MeshStandardMaterial({ color: 0x373d47, roughness: 0.7, metalness: 0.1 });
const gunAccent = new THREE.MeshStandardMaterial({
  color: 0x0e1319,
  roughness: 0.3,
  metalness: 0.4,
  emissive: 0x39c0ff,
  emissiveIntensity: 2.2,
});
const glassMat = new THREE.MeshStandardMaterial({
  color: 0x0a1a22,
  roughness: 0.08,
  metalness: 0.2,
  emissive: 0x1a4b5e,
  emissiveIntensity: 0.8,
});

function part(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

const box = (w: number, h: number, d: number, r = 0.006) => new RoundedBoxGeometry(w, h, d, 2, r);
const cyl = (rt: number, rb: number, h: number, seg = 14) => new THREE.CylinderGeometry(rt, rb, h, seg);

export interface BuiltWeapon {
  group: THREE.Group;
  muzzle: THREE.Object3D;
  /** Sight axis used when aiming down sights. */
  sight: THREE.Object3D;
  magazine: THREE.Object3D;
}

function buildRifle(): BuiltWeapon {
  const g = new THREE.Group();
  part(g, box(0.062, 0.09, 0.44), gunMetal, 0, 0, 0); // receiver
  part(g, box(0.05, 0.055, 0.34), gunPolymer, 0, 0.004, -0.36); // handguard
  part(g, cyl(0.011, 0.011, 0.42), gunDark, 0, 0.006, -0.44, Math.PI / 2);
  part(g, cyl(0.017, 0.014, 0.05), gunDark, 0, 0.006, -0.66, Math.PI / 2); // brake
  part(g, box(0.03, 0.14, 0.055), gunPolymer, 0, -0.1, 0.02, 0.22); // mag well grip
  const mag = part(g, box(0.032, 0.15, 0.075), gunPolymer, 0, -0.105, -0.11, -0.12);
  part(g, box(0.045, 0.075, 0.2), gunPolymer, 0, -0.014, 0.28); // stock
  part(g, box(0.038, 0.028, 0.13), gunDark, 0, 0.052, 0.24); // cheek riser
  // Optic
  part(g, box(0.042, 0.042, 0.16), gunDark, 0, 0.078, -0.03);
  const sight = new THREE.Object3D();
  sight.position.set(0, 0.078, -0.03);
  g.add(sight);
  part(g, cyl(0.016, 0.016, 0.006, 16), glassMat, 0, 0.078, -0.111, Math.PI / 2);
  part(g, box(0.05, 0.004, 0.2), gunAccent, 0, 0.048, -0.34); // rail glow strip
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.006, -0.69);
  g.add(muzzle);
  return { group: g, muzzle, sight, magazine: mag };
}

function buildSMG(): BuiltWeapon {
  const g = new THREE.Group();
  part(g, box(0.058, 0.088, 0.3), gunPolymer, 0, 0, 0);
  part(g, cyl(0.009, 0.009, 0.2), gunDark, 0, 0.01, -0.24, Math.PI / 2);
  part(g, box(0.03, 0.13, 0.05), gunPolymer, 0, -0.095, 0.03, 0.2);
  const mag = part(g, box(0.03, 0.17, 0.055), gunDark, 0, -0.115, -0.06, -0.05);
  part(g, box(0.04, 0.06, 0.12), gunDark, 0, -0.006, 0.2);
  part(g, box(0.04, 0.03, 0.1), gunAccent, 0, 0.052, -0.06);
  const sight = new THREE.Object3D();
  sight.position.set(0, 0.07, -0.06);
  g.add(sight);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.35);
  g.add(muzzle);
  return { group: g, muzzle, sight, magazine: mag };
}

function buildShotgun(): BuiltWeapon {
  const g = new THREE.Group();
  part(g, box(0.07, 0.095, 0.4), gunPolymer, 0, 0, -0.02);
  part(g, cyl(0.016, 0.016, 0.52), gunDark, 0, 0.016, -0.36, Math.PI / 2);
  part(g, cyl(0.013, 0.013, 0.42), gunMetal, 0, -0.018, -0.32, Math.PI / 2); // tube mag
  const pump = part(g, box(0.05, 0.05, 0.13), gunPolymer, 0, -0.014, -0.3);
  part(g, box(0.032, 0.14, 0.055), gunPolymer, 0, -0.1, 0.06, 0.24);
  part(g, box(0.05, 0.085, 0.22), gunPolymer, 0, -0.02, 0.28);
  const sight = new THREE.Object3D();
  sight.position.set(0, 0.06, -0.1);
  g.add(sight);
  part(g, box(0.012, 0.022, 0.02), gunAccent, 0, 0.058, -0.5);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.016, -0.63);
  g.add(muzzle);
  return { group: g, muzzle, sight, magazine: pump };
}

function buildSniper(): BuiltWeapon {
  const g = new THREE.Group();
  part(g, box(0.06, 0.1, 0.5), gunMetal, 0, 0, 0);
  part(g, cyl(0.013, 0.013, 0.6), gunDark, 0, 0.008, -0.55, Math.PI / 2);
  part(g, cyl(0.021, 0.018, 0.07), gunDark, 0, 0.008, -0.85, Math.PI / 2);
  part(g, box(0.032, 0.145, 0.06), gunPolymer, 0, -0.105, 0.05, 0.24);
  const mag = part(g, box(0.034, 0.1, 0.08), gunDark, 0, -0.085, -0.09);
  part(g, box(0.05, 0.09, 0.3), gunPolymer, 0, -0.014, 0.34);
  // Big scope
  part(g, cyl(0.028, 0.028, 0.3, 18), gunDark, 0, 0.1, -0.05, Math.PI / 2);
  part(g, cyl(0.036, 0.03, 0.06, 18), gunDark, 0, 0.1, -0.22, Math.PI / 2);
  part(g, cyl(0.03, 0.03, 0.006, 18), glassMat, 0, 0.1, -0.25, Math.PI / 2);
  part(g, box(0.03, 0.05, 0.03), gunMetal, 0, 0.06, -0.14);
  part(g, box(0.03, 0.05, 0.03), gunMetal, 0, 0.06, 0.06);
  part(g, box(0.03, 0.006, 0.16), gunAccent, 0, 0.13, -0.05);
  const sight = new THREE.Object3D();
  sight.position.set(0, 0.1, -0.05);
  g.add(sight);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.008, -0.89);
  g.add(muzzle);
  return { group: g, muzzle, sight, magazine: mag };
}

const BUILDERS: Record<WeaponId, () => BuiltWeapon> = {
  [WeaponId.Rifle]: buildRifle,
  [WeaponId.SMG]: buildSMG,
  [WeaponId.Shotgun]: buildShotgun,
  [WeaponId.Sniper]: buildSniper,
};

/** Weapons are modelled at real scale, then pulled back slightly so a 0.9m
 * rifle does not swallow the lower half of the screen. */
const VM_SCALE = 0.72;
const HIP = new THREE.Vector3(0.15, -0.125, -0.62);
const ADS_TARGET = new THREE.Vector3(0, -0.026, -0.54);

/**
 * First-person weapon rig. Lives on its own scene + camera so it never clips
 * into level geometry, which is the usual trick for a clean FPS viewmodel.
 */
export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly root = new THREE.Group();

  private weapons = new Map<WeaponId, BuiltWeapon>();
  private current: BuiltWeapon;
  private currentId: WeaponId = WeaponId.Rifle;

  private swayX = 0;
  private swayY = 0;
  private bobT = 0;
  private recoilPos = 0;
  private recoilRot = 0;
  private adsT = 0;
  private reloadT = 0;
  private landT = 0;

  private muzzleLight: THREE.PointLight;
  private muzzleSprite: THREE.Sprite;
  private flashT = 0;
  private swayScale = 1;
  private bobScale = 1;
  private readonly muzzleScratch = new THREE.Vector3();

  constructor(fov: number) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.01, 12);
    this.scene.add(this.root);

    const key = new THREE.DirectionalLight(0xfff1de, 3.2);
    key.position.set(-0.7, 1.0, 0.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6ea8ff, 1.8);
    rim.position.set(0.9, 0.1, -0.9);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xbfd6ff, 1.0);
    fill.position.set(0.3, -0.8, 0.6);
    this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(0x3a4757, 1.4));

    this.root.scale.setScalar(VM_SCALE);
    this.current = this.getWeapon(WeaponId.Rifle);
    this.root.add(this.current.group);

    this.muzzleLight = new THREE.PointLight(0xffd28a, 0, 3, 2);
    this.scene.add(this.muzzleLight);

    const flashTex = makeFlashTexture();
    this.muzzleSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.muzzleSprite.scale.setScalar(0.28);
    this.muzzleSprite.visible = false;
    this.scene.add(this.muzzleSprite);
  }

  private getWeapon(id: WeaponId): BuiltWeapon {
    let w = this.weapons.get(id);
    if (!w) {
      w = BUILDERS[id]();
      this.weapons.set(id, w);
    }
    return w;
  }

  setWeapon(id: WeaponId): void {
    if (id === this.currentId) return;
    this.root.remove(this.current.group);
    this.currentId = id;
    this.current = this.getWeapon(id);
    this.root.add(this.current.group);
    this.reloadT = 0;
    this.recoilPos = 0.06;
  }

  /** 0 disables the motion entirely, for players who find it nauseating. */
  /** Hide the whole rig, e.g. while a scope is covering the screen. */
  setVisible(v: boolean): void {
    this.scene.visible = v;
  }

  setStyle(sway: number, bob: number): void {
    this.swayScale = Math.max(0, sway);
    this.bobScale = Math.max(0, bob);
  }

  setEnvironment(env: THREE.Texture | null): void {
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.75;
  }

  onFire(kick: number): void {
    this.recoilPos = Math.min(0.14, this.recoilPos + 0.045 * kick);
    this.recoilRot = Math.min(0.4, this.recoilRot + 0.12 * kick);
    this.flashT = 1;
  }

  onLand(strength: number): void {
    this.landT = Math.min(1, this.landT + strength);
  }

  onReload(): void {
    this.reloadT = 1;
  }

  /**
   * Muzzle position in *view space*. The viewmodel lives in its own scene whose
   * camera sits at the origin, so this is the offset from the player's eye and
   * must be pushed through the world camera before it means anything in the
   * level. Returns a shared vector: copy it if you need to keep it.
   */
  get muzzleViewSpace(): THREE.Vector3 {
    return this.current.muzzle.getWorldPosition(this.muzzleScratch);
  }

  update(dt: number, opts: { lookDx: number; lookDy: number; speed: number; grounded: boolean; ads: number; reloadProgress: number }): void {
    const { lookDx, lookDy, speed, grounded, ads } = opts;

    // Sway trails the mouse, then springs back.
    const swayGain = 0.45 * this.swayScale;
    this.swayX += (-lookDx * swayGain - this.swayX) * Math.min(1, 26 * dt);
    this.swayY += (-lookDy * swayGain - this.swayY) * Math.min(1, 26 * dt);
    this.swayX *= 1 - Math.min(1, 9 * dt);
    this.swayY *= 1 - Math.min(1, 9 * dt);

    this.adsT += (ads - this.adsT) * Math.min(1, 16 * dt);
    const adsEase = this.adsT * this.adsT * (3 - 2 * this.adsT);

    const moving = grounded && speed > 0.6;
    this.bobT += dt * (moving ? 5.5 + speed * 0.75 : 2.2);
    const bobAmp = (moving ? Math.min(1, speed / 7) : 0.12) * (1 - adsEase * 0.75) * this.bobScale;
    const bobX = Math.sin(this.bobT) * 0.016 * bobAmp;
    const bobY = Math.abs(Math.cos(this.bobT)) * 0.013 * bobAmp;

    this.recoilPos *= 1 - Math.min(1, 11 * dt);
    this.recoilRot *= 1 - Math.min(1, 9 * dt);
    this.landT *= 1 - Math.min(1, 7 * dt);
    this.reloadT = opts.reloadProgress > 0 ? 1 : this.reloadT * (1 - Math.min(1, 6 * dt));

    // Hip -> ADS interpolation. In ADS the sight is pulled onto the screen
    // centre, which is what makes iron sights line up with the crosshair.
    const sightOff = this.current.sight.position;
    const target = new THREE.Vector3().lerpVectors(HIP, ADS_TARGET, adsEase);
    target.x -= sightOff.x * adsEase * VM_SCALE;
    target.y -= sightOff.y * adsEase * VM_SCALE;

    const reloadEase = this.reloadT * this.reloadT;
    this.root.position.set(
      target.x + (this.swayX * 0.05 + bobX) * (1 - adsEase * 0.8),
      target.y + (this.swayY * 0.05 + bobY) * (1 - adsEase * 0.8) - this.landT * 0.05 - reloadEase * 0.11,
      target.z + this.recoilPos,
    );
    this.root.rotation.set(
      this.recoilRot * 0.9 + this.swayY * 0.12 + reloadEase * 0.55,
      this.swayX * 0.16 * (1 - adsEase) + reloadEase * 0.35,
      this.swayX * 0.1 * (1 - adsEase) - reloadEase * 0.25,
    );

    // Magazine drops away partway through the reload.
    const mag = this.current.magazine;
    const magDrop = Math.sin(Math.min(1, opts.reloadProgress) * Math.PI);
    mag.position.y = mag.userData.baseY ?? (mag.userData.baseY = mag.position.y);
    mag.position.y -= magDrop * 0.14;

    // Muzzle flash.
    this.flashT = Math.max(0, this.flashT - dt * 22);
    const lit = this.flashT > 0;
    this.muzzleLight.intensity = this.flashT * 14;
    if (lit) {
      const p = this.current.muzzle.getWorldPosition(new THREE.Vector3());
      this.muzzleLight.position.copy(p);
      this.muzzleSprite.position.copy(p);
      this.muzzleSprite.material.rotation = Math.random() * Math.PI * 2;
      this.muzzleSprite.scale.setScalar(0.2 + this.flashT * 0.22);
      this.muzzleSprite.material.opacity = this.flashT;
    }
    this.muzzleSprite.visible = lit;
  }

  resize(aspect: number, fov: number): void {
    this.camera.aspect = aspect;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }
}

function makeFlashTexture(): THREE.Texture {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  g.addColorStop(0, 'rgba(255,250,225,1)');
  g.addColorStop(0.22, 'rgba(255,205,120,0.85)');
  g.addColorStop(0.55, 'rgba(255,140,50,0.28)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, n, n);
  // Star burst spikes.
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgba(255,235,190,0.55)';
  ctx.lineWidth = 5;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(n / 2, n / 2);
    ctx.lineTo(n / 2 + Math.cos(a) * n * 0.48, n / 2 + Math.sin(a) * n * 0.48);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
