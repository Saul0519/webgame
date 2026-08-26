import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PLAYER_CROUCH_HEIGHT } from '@webgame/shared';

/** Distinct, readable player colours — accent trim only, so silhouettes stay dark. */
const TRIM_COLOURS = [0x4cc7ff, 0xffb454, 0x8bff6e, 0xff6ec7, 0xc08bff, 0xffe45e, 0x5effd6, 0xff7a5e];

const shared = {
  body: null as THREE.MeshStandardMaterial | null,
  trim: null as THREE.MeshStandardMaterial | null,
  geo: null as Record<string, THREE.BufferGeometry> | null,
};

let lowSpec = false;

/** Call before any character is built; swaps in cheaper shading on weak GPUs. */
export function setCharacterQuality(quality: 'low' | 'medium' | 'high'): void {
  lowSpec = quality === 'low';
}

function ensureShared(): void {
  if (shared.body) return;
  shared.body = lowSpec
    ? (new THREE.MeshLambertMaterial({ color: 0x4a5361 }) as unknown as THREE.MeshStandardMaterial)
    : new THREE.MeshStandardMaterial({
        color: 0x4a5361,
        roughness: 0.58,
        metalness: 0.25,
      });
  shared.trim = new THREE.MeshStandardMaterial({
    color: 0x232a34,
    roughness: 0.42,
    metalness: 0.2,
    emissive: 0x4cc7ff,
    emissiveIntensity: 0.55,
  });
  shared.geo = {
    torso: new RoundedBoxGeometry(0.52, 0.62, 0.3, 3, 0.06),
    hips: new RoundedBoxGeometry(0.44, 0.24, 0.28, 3, 0.06),
    head: new RoundedBoxGeometry(0.24, 0.26, 0.27, 4, 0.08),
    visor: new THREE.BoxGeometry(0.2, 0.075, 0.02),
    upperArm: new RoundedBoxGeometry(0.15, 0.34, 0.16, 3, 0.05),
    foreArm: new RoundedBoxGeometry(0.13, 0.32, 0.14, 3, 0.05),
    thigh: new RoundedBoxGeometry(0.19, 0.42, 0.2, 3, 0.05),
    shin: new RoundedBoxGeometry(0.16, 0.42, 0.17, 3, 0.05),
    foot: new RoundedBoxGeometry(0.17, 0.1, 0.3, 3, 0.04),
    pack: new RoundedBoxGeometry(0.34, 0.36, 0.16, 3, 0.05),
    gun: new RoundedBoxGeometry(0.08, 0.11, 0.72, 2, 0.03),
  };
}

export interface CharacterState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  speed: number;
  grounded: boolean;
  crouching: boolean;
  dead: boolean;
  health: number;
  name: string;
}

/** Chakra Petch carries no Hangul, so Korean names fall through to a real face. */
const LABEL_FONT =
  '"Chakra Petch", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif';
const LABEL_W = 512;
const LABEL_H = 128;

function makeLabelTexture(name: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_W;
  canvas.height = LABEL_H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Hangul is full-width, so sixteen Korean characters are roughly twice as
  // wide as sixteen Latin ones and ran off both ends of the plate. Shrink to
  // fit rather than clip: a squeezed name still identifies who you are shooting.
  let size = 60;
  ctx.font = `600 ${size}px ${LABEL_FONT}`;
  const maxWidth = LABEL_W - 24;
  const width = ctx.measureText(name).width;
  if (width > maxWidth) {
    size = Math.max(22, Math.floor((size * maxWidth) / width));
    ctx.font = `600 ${size}px ${LABEL_FONT}`;
  }

  ctx.lineWidth = Math.max(4, size * 0.13);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(name, LABEL_W / 2, LABEL_H / 2, maxWidth);
  ctx.fillStyle = '#e6f2ff';
  ctx.fillText(name, LABEL_W / 2, LABEL_H / 2, maxWidth);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeLabel(name: string): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: makeLabelTexture(name),
    depthTest: true,
    transparent: true,
    opacity: 0.92,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.1, 0.275, 1);
  return sprite;
}

/**
 * Procedural humanoid built from rounded boxes. No skinning: the limbs are
 * pivot groups driven by a walk phase, which reads cleanly at arena distances
 * and costs nothing to load.
 */
export class CharacterModel {
  readonly root = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly shinL = new THREE.Group();
  private readonly shinR = new THREE.Group();
  private readonly label: THREE.Sprite;
  private labelText: string;
  private readonly trimMat: THREE.MeshStandardMaterial;
  private phase = 0;
  private smoothedYaw = 0;
  private bodyYaw = 0;
  private stanceY = 0;
  private dead = false;
  private deadTilt = 0;

  constructor(playerId: number, name: string) {
    ensureShared();
    const body = shared.body!;
    const geo = shared.geo!;
    this.trimMat = shared.trim!.clone();
    this.trimMat.emissive = new THREE.Color(TRIM_COLOURS[playerId % TRIM_COLOURS.length]);

    // Only the big silhouette parts cast shadows: small props doubled the draw
    // call count for no visible gain, and characters never receive them.
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, y = 0, z = 0, shadow = true) => {
      const mm = new THREE.Mesh(g, m);
      mm.position.set(0, y, z);
      mm.castShadow = shadow;
      mm.receiveShadow = false;
      return mm;
    };

    // Hips are the root of the body; everything hangs off them.
    const hips = mesh(geo.hips, body, 0.9);
    this.root.add(hips);

    this.torso.position.set(0, 1.02, 0);
    this.torso.add(mesh(geo.torso, body, 0.3));
    this.torso.add(mesh(geo.pack, this.trimMat, 0.3, -0.21, false));
    this.root.add(this.torso);

    this.head.position.set(0, 0.68, 0);
    this.head.add(mesh(geo.head, body, 0.1));
    const visor = mesh(geo.visor, this.trimMat, 0.11, 0.135, false);
    this.head.add(visor);
    this.torso.add(this.head);

    const buildArm = (side: number, group: THREE.Group) => {
      group.position.set(side * 0.32, 0.52, 0);
      group.add(mesh(geo.upperArm, body, -0.17));
      const fore = new THREE.Group();
      fore.position.set(0, -0.34, 0);
      fore.add(mesh(geo.foreArm, body, -0.16));
      group.add(fore);
      this.torso.add(group);
      return fore;
    };
    const foreR = buildArm(1, this.armR);
    buildArm(-1, this.armL);
    // Weapon carried in the right hand, pointing forward.
    const gun = mesh(geo.gun, body, -0.3, 0.22, false);
    gun.rotation.x = Math.PI / 2;
    foreR.add(gun);

    const buildLeg = (side: number, group: THREE.Group, shin: THREE.Group) => {
      group.position.set(side * 0.13, 0.92, 0);
      group.add(mesh(geo.thigh, body, -0.21));
      shin.position.set(0, -0.42, 0);
      shin.add(mesh(geo.shin, body, -0.21));
      shin.add(mesh(geo.foot, body, -0.42, 0.06, false));
      group.add(shin);
      this.root.add(group);
    };
    buildLeg(1, this.legR, this.shinR);
    buildLeg(-1, this.legL, this.shinL);

    this.labelText = name;
    this.label = makeLabel(name);
    this.label.position.set(0, 2.16, 0);
    this.root.add(this.label);
  }

  setName(name: string): void {
    if (name === this.labelText) return;
    this.labelText = name;
    const old = this.label.material.map;
    this.label.material.map = makeLabelTexture(name);
    this.label.material.needsUpdate = true;
    old?.dispose();
  }

  update(dt: number, s: CharacterState): void {
    this.root.position.set(s.x, s.y, s.z);

    // Aim yaw drives the head/torso; the body turns toward it more slowly.
    this.smoothedYaw = s.yaw;
    let delta = ((this.smoothedYaw - this.bodyYaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (delta < -Math.PI) delta += Math.PI * 2;
    const turnRate = s.speed > 0.5 ? 10 : 3.2;
    this.bodyYaw += delta * Math.min(1, turnRate * dt);
    this.root.rotation.y = this.bodyYaw + Math.PI;
    this.torso.rotation.y = delta * 0.55;
    this.head.rotation.x = -s.pitch * 0.85;
    this.head.rotation.y = delta * 0.35;

    // Crouch: drop the whole rig and shorten the stance.
    const targetStance = s.crouching ? -(1.8 - PLAYER_CROUCH_HEIGHT) * 0.55 : 0;
    this.stanceY += (targetStance - this.stanceY) * Math.min(1, 12 * dt);
    this.torso.position.y = 1.02 + this.stanceY;
    this.legL.position.y = 0.92 + this.stanceY * 0.4;
    this.legR.position.y = 0.92 + this.stanceY * 0.4;

    if (s.dead) {
      this.dead = true;
      this.deadTilt = Math.min(1, this.deadTilt + dt * 4);
      this.root.rotation.x = -this.deadTilt * Math.PI * 0.48;
      this.root.position.y = s.y + this.deadTilt * 0.15;
      this.label.visible = false;
      return;
    }
    if (this.dead) {
      this.dead = false;
      this.deadTilt = 0;
      this.root.rotation.x = 0;
      this.label.visible = true;
    }

    // Walk cycle.
    const stride = Math.min(1, s.speed / 7);
    this.phase += dt * (4 + s.speed * 1.35);
    const swing = Math.sin(this.phase) * stride;
    const swing2 = Math.sin(this.phase + Math.PI) * stride;
    if (s.grounded) {
      this.legR.rotation.x = swing * 0.85;
      this.legL.rotation.x = swing2 * 0.85;
      this.shinR.rotation.x = Math.max(0, -swing) * 0.9;
      this.shinL.rotation.x = Math.max(0, -swing2) * 0.9;
      this.armL.rotation.x = swing * 0.4 - 0.25;
      this.torso.position.y = 1.02 + this.stanceY + Math.abs(Math.sin(this.phase)) * 0.035 * stride;
    } else {
      this.legR.rotation.x += (0.35 - this.legR.rotation.x) * Math.min(1, 8 * dt);
      this.legL.rotation.x += (-0.25 - this.legL.rotation.x) * Math.min(1, 8 * dt);
      this.shinR.rotation.x += (0.5 - this.shinR.rotation.x) * Math.min(1, 8 * dt);
      this.shinL.rotation.x += (0.3 - this.shinL.rotation.x) * Math.min(1, 8 * dt);
      this.armL.rotation.x += (-0.5 - this.armL.rotation.x) * Math.min(1, 8 * dt);
    }

    // Right arm holds the weapon at aim level regardless of stride.
    this.armR.rotation.x = -1.15 - s.pitch * 0.5;
    this.armR.rotation.z = -0.18;
    this.armL.rotation.z = 0.2;

    this.label.position.y = 2.16 + this.stanceY;
  }

  dispose(): void {
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.trimMat.dispose();
  }
}

export function playerColour(id: number): number {
  return TRIM_COLOURS[id % TRIM_COLOURS.length];
}
