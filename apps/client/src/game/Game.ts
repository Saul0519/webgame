import * as THREE from 'three';
import {
  Btn,
  CollisionWorld,
  INTERP_DELAY_MS,
  MAX_HEALTH,
  PFlag,
  TICK_DT,
  TICK_MS,
  WEAPONS,
  WeaponId,
  coneSpread,
  createMoveState,
  dirFromAngles,
  fireIntervalMs,
  getMap,
  mulberry32,
  quantAngle,
  simulateMovement,
  type GameMap,
  type MoveState,
  type Vec3,
  type WireInput,
} from '@webgame/shared';
import { Connection, type GameConnection, type GameEvent, type SnapPlayer, type Snapshot } from '../net/Connection.js';
import { LocalConnection } from '../net/LocalConnection.js';
import { RenderSystem, type Quality } from './Renderer.js';
import { buildSurfaceMaterials } from './Materials.js';
import { buildLevel } from './LevelBuilder.js';
import { CharacterModel } from './CharacterModel.js';
import { ViewModel } from './ViewModel.js';
import { Effects } from './Effects.js';
import { AudioEngine } from './AudioEngine.js';
import type { Hud, ScoreRow } from '../ui/Hud.js';

const BASE_FOV = 92;
/** The viewmodel renders through a narrower lens than the world, the usual
 * trick for a wide gameplay FOV without a fisheye weapon. */
const VM_FOV_RATIO = 0.62;
/** Extra buffer on top of the interpolation delay before we run dry. */
const SNAPSHOT_BUFFER = 3;

interface RemoteSample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  speed: number;
}

interface RemotePlayer {
  id: number;
  model: CharacterModel;
  buffer: RemoteSample[];
  health: number;
  weapon: WeaponId;
  lastFootstep: number;
}

interface LocalWeapon {
  id: WeaponId;
  ammo: number;
  nextFireAt: number;
  reloadDoneAt: number;
  bloom: number;
  shots: number;
}

export interface GameOptions {
  sensitivity: number;
  quality: Quality;
  name: string;
  /** Host the match in this tab instead of connecting to a server. */
  offline?: boolean;
  /** Total participants (including you) when bots fill the match. */
  fillTo?: number;
  botSkill?: number;
}

export class Game {
  private readonly render: RenderSystem;
  private readonly vm: ViewModel;
  private readonly effects: Effects;
  private readonly audio = new AudioEngine();
  private readonly hud: Hud;
  private conn: GameConnection;
  readonly offline: boolean;
  private map: GameMap;
  private world: CollisionWorld;

  private selfId = 0;
  private local: MoveState;
  private yaw = 0;
  private pitch = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private health = MAX_HEALTH;
  private dead = false;
  private respawnAt = 0;
  private lastKiller = '';

  private weapon: LocalWeapon = { id: WeaponId.Rifle, ammo: 30, nextFireAt: 0, reloadDoneAt: 0, bloom: 0, shots: 0 };
  private serverMag = 30;

  private inputSeq = 1;
  private pending: WireInput[] = [];
  private unsent: WireInput[] = [];
  private accumulator = 0;
  private sendAccum = 0;
  private clock = 0;

  private keys = new Set<string>();
  private mouseButtons = 0;
  private lookDx = 0;
  private lookDy = 0;
  private sensitivity: number;
  private chatOpen = false;
  private scoreboardOpen = false;

  private remotes = new Map<number, RemotePlayer>();
  private scoreRows: ScoreRow[] = [];
  private matchRemaining = 0;
  private matchKillLimit = 30;
  private intermission = false;
  private matchStateKnown = false;

  private predictionError = new THREE.Vector3();
  private hudDamage = 0;
  private lastFrame = 0;
  private running = false;
  private disposed = false;
  private footstepT = 0;
  private prevVy = 0;
  private frameHandle = 0;
  private onDisconnect: (reason: string) => void;

  private tmpVec = new THREE.Vector3();
  private tmpMuzzle = new THREE.Vector3();

  constructor(container: HTMLElement, hud: Hud, opts: GameOptions, onDisconnect: (reason: string) => void) {
    this.hud = hud;
    this.sensitivity = opts.sensitivity;
    this.onDisconnect = onDisconnect;

    this.map = getMap('reactor');
    this.world = new CollisionWorld(this.map);
    this.local = createMoveState(0, 1, 0);

    this.render = new RenderSystem(container, BASE_FOV);
    this.render.applyMap(this.map);

    const materials = buildSurfaceMaterials();
    const level = buildLevel(this.map, materials);
    this.render.scene.add(level.group);

    this.vm = new ViewModel(BASE_FOV * VM_FOV_RATIO);
    this.vm.setEnvironment(this.render.environment);
    this.render.setQuality(opts.quality, this.vm.scene, this.vm.camera);
    this.render.resize();

    this.effects = new Effects(this.render.scene);

    const handlers = {
      onWelcome: (w: { playerId: number; roster: { id: number; name: string }[] }) =>
        this.onWelcome(w.playerId, w.roster),
      onSnapshot: (s: Snapshot) => this.onSnapshot(s),
      onEvents: (e: GameEvent[]) => this.onEvents(e),
      onClose: (reason: string) => this.onDisconnect(reason),
    };
    this.offline = opts.offline === true;
    this.conn = this.offline
      ? new LocalConnection(handlers, { fillTo: opts.fillTo ?? 6, botSkill: opts.botSkill ?? 0.55 })
      : new Connection(handlers);

    this.bindInput();
    window.addEventListener('resize', this.handleResize);
  }

  /** Exposed for the browser console and automated smoke tests. */
  get debug(): { render: RenderSystem; vm: ViewModel; local: MoveState } {
    return { render: this.render, vm: this.vm, local: this.local };
  }

  async connect(room: string, name: string): Promise<void> {
    await this.conn.connect(room, name);
    this.audio.ensure();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.hud.show();
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('pointerlockchange', this.handlePointerLock);
    document.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('wheel', this.handleWheel);
    window.removeEventListener('contextmenu', preventDefault);
    this.conn.close();
    this.render.renderer.dispose();
    this.render.canvas.remove();
  }

  // -------------------------------------------------------------------- input

  private bindInput(): void {
    const canvas = this.render.canvas;
    canvas.addEventListener('click', () => {
      if (!this.chatOpen && document.pointerLockElement !== canvas) {
        void canvas.requestPointerLock();
        this.audio.ensure();
      }
    });
    document.addEventListener('pointerlockchange', this.handlePointerLock);
    document.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('wheel', this.handleWheel, { passive: true });
    window.addEventListener('contextmenu', preventDefault);
  }

  private get locked(): boolean {
    return document.pointerLockElement === this.render.canvas;
  }

  private handlePointerLock = (): void => {
    this.hud.setPointerHint(!this.locked && !this.chatOpen);
    if (!this.locked) {
      this.keys.clear();
      this.mouseButtons = 0;
    }
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    const s = this.sensitivity * 0.0022;
    this.yaw -= e.movementX * s;
    this.pitch -= e.movementY * s;
    this.pitch = Math.max(-1.5533, Math.min(1.5533, this.pitch));
    this.lookDx += e.movementX * 0.001;
    this.lookDy += e.movementY * 0.001;
  };

  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseButtons |= 1 << e.button;
  };

  private handleMouseUp = (e: MouseEvent): void => {
    this.mouseButtons &= ~(1 << e.button);
  };

  private handleWheel = (e: WheelEvent): void => {
    if (!this.locked) return;
    const order = [WeaponId.Rifle, WeaponId.SMG, WeaponId.Shotgun, WeaponId.Sniper];
    const i = order.indexOf(this.weapon.id);
    const next = order[(i + (e.deltaY > 0 ? 1 : order.length - 1)) % order.length];
    this.switchWeapon(next);
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (this.chatOpen) return;
    if (e.code === 'KeyY') {
      e.preventDefault();
      this.openChat();
      return;
    }
    if (e.code === 'Tab') {
      e.preventDefault();
      this.scoreboardOpen = true;
      this.hud.toggleScoreboard(true);
      return;
    }
    if (e.code === 'KeyM') {
      this.audio.setMuted(!this.audio.isMuted);
      this.hud.showToast(this.audio.isMuted ? 'Audio muted' : 'Audio on');
      return;
    }
    const weaponKeys: Record<string, WeaponId> = {
      Digit1: WeaponId.Rifle,
      Digit2: WeaponId.SMG,
      Digit3: WeaponId.Shotgun,
      Digit4: WeaponId.Sniper,
    };
    if (weaponKeys[e.code] !== undefined) {
      this.switchWeapon(weaponKeys[e.code]);
      return;
    }
    if (e.code === 'Space' && this.dead && performance.now() >= this.respawnAt) {
      this.conn.sendRespawn();
    }
    this.keys.add(e.code);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Tab') {
      this.scoreboardOpen = false;
      this.hud.toggleScoreboard(false);
    }
    this.keys.delete(e.code);
  };

  private handleResize = (): void => {
    this.render.resize();
    this.vm.resize(window.innerWidth / window.innerHeight, this.render.camera.fov * VM_FOV_RATIO);
  };

  private openChat(): void {
    this.chatOpen = true;
    document.exitPointerLock();
    this.hud.openChat(
      (text) => this.conn.sendChat(text),
      () => {
        this.chatOpen = false;
        this.hud.setPointerHint(true);
      },
    );
  }

  private switchWeapon(id: WeaponId): void {
    if (id === this.weapon.id) return;
    this.weapon = { id, ammo: WEAPONS[id].magSize, nextFireAt: this.clock + 350, reloadDoneAt: 0, bloom: 0, shots: 0 };
    this.vm.setWeapon(id);
    this.conn.sendWeapon(id);
  }

  // ------------------------------------------------------------------ network

  private onWelcome(id: number, roster: { id: number; name: string }[]): void {
    this.selfId = id;
    this.hud.setSelf(id);
    for (const r of roster) {
      this.hud.setName(r.id, r.name);
      if (r.id !== id) this.ensureRemote(r.id);
    }
  }

  private ensureRemote(id: number): RemotePlayer {
    let r = this.remotes.get(id);
    if (!r) {
      const model = new CharacterModel(id, this.hud.nameOf(id));
      this.render.scene.add(model.root);
      r = { id, model, buffer: [], health: MAX_HEALTH, weapon: WeaponId.Rifle, lastFootstep: 0 };
      this.remotes.set(id, r);
    }
    return r;
  }

  private dropRemote(id: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.render.scene.remove(r.model.root);
    r.model.dispose();
    this.remotes.delete(id);
  }

  private onSnapshot(snap: Snapshot): void {
    let self: SnapPlayer | null = null;
    for (const p of snap.players) {
      if (p.id === this.selfId) {
        self = p;
        continue;
      }
      const r = this.ensureRemote(p.id);
      r.health = p.health;
      r.weapon = p.weapon as WeaponId;
      r.buffer.push({
        t: snap.recvTime,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        flags: p.flags,
        speed: Math.hypot(p.vx, p.vz),
      });
      // Keep a little more than the interpolation window.
      while (r.buffer.length > 24) r.buffer.shift();
    }

    // Players that vanished from the snapshot have left.
    const present = new Set(snap.players.map((p) => p.id));
    for (const id of [...this.remotes.keys()]) {
      if (!present.has(id)) this.dropRemote(id);
    }

    this.serverMag = snap.magSize;
    if (Math.abs(this.weapon.ammo - snap.ammo) > 1) this.weapon.ammo = snap.ammo;
    if (snap.reloadRemainMs > 0) this.weapon.reloadDoneAt = this.clock + snap.reloadRemainMs;

    if (!self) return;

    const wasDead = this.dead;
    this.health = self.health;
    this.dead = (self.flags & PFlag.Dead) !== 0;
    if (this.dead && !wasDead) {
      this.audio.died();
      this.respawnAt = performance.now() + 2500;
    }

    // --- Reconciliation ---
    const before = new THREE.Vector3(this.local.x, this.local.y, this.local.z);

    this.local.x = self.x;
    this.local.y = self.y;
    this.local.z = self.z;
    this.local.vx = self.vx;
    this.local.vy = self.vy;
    this.local.vz = self.vz;
    this.local.crouching = (self.flags & PFlag.Crouching) !== 0;
    this.local.grounded = (self.flags & PFlag.Grounded) !== 0;

    // Drop inputs the server has already consumed, replay the rest.
    while (this.pending.length > 0 && this.pending[0].seq <= snap.ackSeq) this.pending.shift();
    for (const inp of this.pending) {
      simulateMovement(
        this.local,
        { forward: inp.forward, right: inp.right, yaw: inp.yaw, pitch: inp.pitch, buttons: inp.buttons },
        this.world,
      );
    }

    // Fold the correction into a render-space offset that decays, so a small
    // server disagreement never shows up as a visible teleport.
    const err = this.tmpVec.set(before.x - this.local.x, before.y - this.local.y, before.z - this.local.z);
    if (err.lengthSq() > 4) {
      this.predictionError.set(0, 0, 0); // too far off to smooth: snap
    } else {
      this.predictionError.add(err);
      if (this.predictionError.lengthSq() > 1) this.predictionError.setLength(1);
    }
  }

  private onEvents(events: GameEvent[]): void {
    for (const ev of events) {
      switch (ev.t) {
        case 'shot':
          this.onShotEvent(ev);
          break;
        case 'impact': {
          this.effects.spawnImpact(ev.x, ev.y, ev.z, ev.nx, ev.ny, ev.nz, ev.surf);
          const d = this.distanceToCamera(ev.x, ev.y, ev.z);
          if (d < 40) this.audio.impact(d, this.panFor(ev.x, ev.z));
          break;
        }
        case 'hit': {
          if (ev.target === this.selfId) {
            // We were hit: ev position is the shooter.
            const angle = this.screenAngleTo(ev.x, ev.z);
            this.hud.takeDamage(angle);
            this.audio.hurt();
            this.hudDamage = 0.85;
          } else {
            this.hud.flashHit(ev.part === 1);
            this.audio.hitmarker(ev.part === 1);
            const cam = this.render.camera.position;
            const bx = ev.x - cam.x;
            const by = ev.y - cam.y;
            const bz = ev.z - cam.z;
            const bl = Math.hypot(bx, by, bz) || 1;
            this.effects.spawnBlood(ev.x, ev.y, ev.z, bx / bl, by / bl, bz / bl, ev.killed);
          }
          break;
        }
        case 'kill': {
          const killer = this.hud.nameOf(ev.killer);
          const victim = this.hud.nameOf(ev.victim);
          const involvesSelf = ev.killer === this.selfId || ev.victim === this.selfId;
          this.hud.addKillfeed(killer, victim, ev.weapon as WeaponId, ev.suicide, involvesSelf);
          if (ev.killer === this.selfId && !ev.suicide) {
            this.audio.kill();
            this.hud.showToast('Eliminated');
          }
          if (ev.victim === this.selfId) {
            this.lastKiller = ev.suicide ? '' : killer;
            this.dead = true;
            this.respawnAt = performance.now() + 2500;
          }
          break;
        }
        case 'spawn': {
          if (ev.id === this.selfId) {
            this.local = createMoveState(ev.x, ev.y, ev.z);
            this.yaw = ev.yaw;
            this.pitch = 0;
            this.recoilPitch = 0;
            this.recoilYaw = 0;
            this.pending.length = 0;
            this.predictionError.set(0, 0, 0);
            this.dead = false;
            this.health = MAX_HEALTH;
            this.weapon.ammo = WEAPONS[this.weapon.id].magSize;
            this.weapon.reloadDoneAt = 0;
            this.weapon.bloom = 0;
            this.audio.spawn();
          } else {
            const r = this.ensureRemote(ev.id);
            r.buffer.length = 0;
          }
          break;
        }
        case 'join':
          this.hud.setName(ev.id, ev.name);
          if (ev.id !== this.selfId) this.ensureRemote(ev.id).model.setName(ev.name);
          break;
        case 'leave':
          this.dropRemote(ev.id);
          break;
        case 'chat':
          this.hud.addChat(this.hud.nameOf(ev.id), ev.text);
          break;
        case 'score':
          this.scoreRows = ev.rows;
          this.hud.setScoreboard(ev.rows);
          for (const row of ev.rows) {
            const r = this.remotes.get(row.id);
            if (r) r.model.setName(row.name);
          }
          break;
        case 'match': {
          const changed = this.matchStateKnown && ev.intermission !== this.intermission;
          this.intermission = ev.intermission;
          this.matchRemaining = ev.remainingMs;
          this.matchKillLimit = ev.killLimit;
          if (changed) this.hud.showToast(ev.intermission ? 'Match over' : 'Round start');
          this.matchStateKnown = true;
          break;
        }
      }
    }
  }

  private onShotEvent(ev: Extract<GameEvent, { t: 'shot' }>): void {
    if (ev.id === this.selfId) return; // already predicted locally
    const hit = this.world.raycast(ev.x, ev.y, ev.z, ev.dx, ev.dy, ev.dz, 200);
    const dist = hit ? hit.t : 60;
    this.effects.spawnTracer(
      ev.x, ev.y, ev.z,
      ev.x + ev.dx * dist, ev.y + ev.dy * dist, ev.z + ev.dz * dist,
    );
    const d = this.distanceToCamera(ev.x, ev.y, ev.z);
    this.audio.gunshot(ev.weapon as WeaponId, d, this.panFor(ev.x, ev.z));
  }

  // ---------------------------------------------------------------- main loop

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.frame);
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.1) dt = 0.1;
    this.clock += dt * 1000;

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < 6) {
      this.tickInput();
      this.accumulator -= TICK_DT;
      steps++;
    }

    this.sendAccum += dt;
    if (this.sendAccum >= 0.025) {
      this.sendAccum = 0;
      if (this.unsent.length > 0) {
        this.conn.sendInputs(this.unsent, this.conn.rttMs / 2 + INTERP_DELAY_MS);
        this.unsent = [];
      }
    }

    this.updateRemotes(dt, now);
    this.updateCamera(dt);
    this.updateViewModel(dt);
    this.effects.update(dt, this.render.camera);
    this.updateHud(dt);

    this.render.render(dt, this.vm.scene, this.vm.camera);
  };

  /** One fixed simulation step: sample input, predict, maybe fire. */
  private tickInput(): void {
    const buttons = this.gatherButtons();
    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const rightRaw = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const walk = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 0.45 : 1;

    // Recoil recovery pulls the view back toward where the player was aiming.
    const w = WEAPONS[this.weapon.id];
    const rec = Math.min(1, w.recoilRecovery * TICK_DT);
    this.pitch -= this.recoilPitch * rec;
    this.yaw -= this.recoilYaw * rec;
    this.recoilPitch *= 1 - rec;
    this.recoilYaw *= 1 - rec;
    this.pitch = Math.max(-1.5533, Math.min(1.5533, this.pitch));

    const input: WireInput = {
      seq: this.inputSeq++,
      buttons,
      forward: this.dead ? 0 : forward * walk,
      right: this.dead ? 0 : rightRaw * walk,
      yaw: quantAngle(this.yaw),
      pitch: quantAngle(this.pitch),
    };

    this.pending.push(input);
    this.unsent.push(input);
    if (this.pending.length > 64) this.pending.shift();

    if (!this.dead) {
      const wasGrounded = this.local.grounded;
      this.prevVy = this.local.vy;
      simulateMovement(
        this.local,
        { forward: input.forward, right: input.right, yaw: input.yaw, pitch: input.pitch, buttons },
        this.world,
      );
      if (!wasGrounded && this.local.grounded) {
        this.vm.onLand(Math.min(1, Math.abs(this.prevVy) / 12));
        this.audio.footstep(0, 0);
      }
      this.predictWeapon(buttons);
    }
  }

  private gatherButtons(): number {
    let b = 0;
    if (this.keys.has('Space')) b |= Btn.Jump;
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC')) b |= Btn.Crouch;
    if ((this.mouseButtons & 1) !== 0) b |= Btn.Fire;
    if ((this.mouseButtons & 2) !== 0) b |= Btn.Ads;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) b |= Btn.Sprint;
    if (this.keys.has('KeyR')) b |= Btn.Reload;
    return b;
  }

  /** Client-side copy of the server's weapon rules, for instant feedback. */
  private predictWeapon(buttons: number): void {
    const w = WEAPONS[this.weapon.id];
    const s = this.weapon;

    if (s.reloadDoneAt > 0 && this.clock >= s.reloadDoneAt) {
      s.reloadDoneAt = 0;
      s.ammo = w.magSize;
      this.audio.reload('in');
    }
    s.bloom = Math.max(0, s.bloom - w.bloomDecay * TICK_DT);

    if ((buttons & Btn.Reload) !== 0 && s.reloadDoneAt === 0 && s.ammo < w.magSize) {
      s.reloadDoneAt = this.clock + w.reloadMs;
      this.vm.onReload();
      this.audio.reload('out');
    }

    if ((buttons & Btn.Fire) === 0) return;
    if (s.reloadDoneAt > 0 || this.clock < s.nextFireAt) return;
    if (s.ammo <= 0) {
      s.reloadDoneAt = this.clock + w.reloadMs;
      this.vm.onReload();
      this.audio.reload('out');
      return;
    }

    s.ammo--;
    s.nextFireAt = this.clock + fireIntervalMs(w);
    s.shots = (s.shots + 1) & 0xffff;

    const ads = (buttons & Btn.Ads) !== 0;
    const spread = (ads ? w.spreadAds : w.spreadHip) + s.bloom;
    // Same seed the server uses, so the predicted pellet pattern matches.
    const rng = mulberry32((this.selfId << 20) ^ (s.shots * 0x9e3779b1));

    const eye = this.tmpVec.set(this.local.x, this.local.y + this.local.eye, this.local.z);
    const base: Vec3 = { x: 0, y: 0, z: 0 };
    dirFromAngles(quantAngle(this.yaw), quantAngle(this.pitch), base);

    const muzzle = this.tmpMuzzle.copy(this.vm.muzzleViewSpace);
    this.render.camera.localToWorld(muzzle);
    for (let i = 0; i < w.pellets; i++) {
      const dir: Vec3 = { x: 0, y: 0, z: 0 };
      coneSpread(base, spread, rng, dir);
      const hit = this.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, 200);
      const dist = hit ? hit.t : 60;
      this.effects.spawnTracer(
        muzzle.x, muzzle.y, muzzle.z,
        eye.x + dir.x * dist, eye.y + dir.y * dist, eye.z + dir.z * dist,
      );
    }
    s.bloom = Math.min(w.bloomMax, s.bloom + w.bloomPerShot);

    // View kick. Sign alternates so sustained fire drifts rather than climbing
    // in a straight line.
    const kickScale = ads ? 0.72 : 1;
    this.recoilPitch += w.recoilUp * kickScale;
    this.pitch += w.recoilUp * kickScale;
    const side = (rng() - 0.5) * 2 * w.recoilSide * kickScale;
    this.recoilYaw += side;
    this.yaw += side;

    this.vm.onFire(w.recoilUp * 60);
    this.audio.gunshot(this.weapon.id, 0, 0);
  }

  // ------------------------------------------------------------ presentation

  private updateRemotes(dt: number, now: number): void {
    const renderTime = now - INTERP_DELAY_MS;
    for (const r of this.remotes.values()) {
      const buf = r.buffer;
      if (buf.length === 0) continue;

      let a = buf[0];
      let b = buf[buf.length - 1];
      for (let i = buf.length - 1; i > 0; i--) {
        if (buf[i - 1].t <= renderTime && buf[i].t >= renderTime) {
          a = buf[i - 1];
          b = buf[i];
          break;
        }
      }
      let f = b.t > a.t ? (renderTime - a.t) / (b.t - a.t) : 1;
      f = Math.max(0, Math.min(1, f));

      const x = a.x + (b.x - a.x) * f;
      const y = a.y + (b.y - a.y) * f;
      const z = a.z + (b.z - a.z) * f;
      const yaw = lerpAngleLocal(a.yaw, b.yaw, f);
      const pitch = a.pitch + (b.pitch - a.pitch) * f;
      const speed = a.speed + (b.speed - a.speed) * f;
      const flags = b.flags;

      r.model.update(dt, {
        x,
        y,
        z,
        yaw,
        pitch,
        speed,
        grounded: (flags & PFlag.Grounded) !== 0,
        crouching: (flags & PFlag.Crouching) !== 0,
        dead: (flags & PFlag.Dead) !== 0,
        health: r.health,
        name: this.hud.nameOf(r.id),
      });

      // Footsteps from other players, distance attenuated.
      if (speed > 2 && (flags & PFlag.Grounded) !== 0 && (flags & PFlag.Dead) === 0) {
        r.lastFootstep -= dt;
        if (r.lastFootstep <= 0) {
          r.lastFootstep = Math.max(0.24, 0.62 - speed * 0.04);
          const d = this.distanceToCamera(x, y, z);
          if (d < 26) this.audio.footstep(d, this.panFor(x, z));
        }
      }

      // Drop samples we have moved past, keeping one before renderTime.
      while (buf.length > SNAPSHOT_BUFFER && buf[1] && buf[1].t < renderTime - 40) buf.shift();
    }
  }

  private updateCamera(dt: number): void {
    // Decay the prediction error so corrections arrive smoothly.
    this.predictionError.multiplyScalar(Math.max(0, 1 - 12 * dt));
    if (this.predictionError.lengthSq() < 1e-6) this.predictionError.set(0, 0, 0);

    const cam = this.render.camera;
    cam.position.set(
      this.local.x + this.predictionError.x,
      this.local.y + this.local.eye + this.predictionError.y,
      this.local.z + this.predictionError.z,
    );
    cam.rotation.set(0, 0, 0);
    cam.rotateY(this.yaw);
    cam.rotateX(this.pitch);

    const ads = (this.mouseButtons & 2) !== 0 && !this.dead ? 1 : 0;
    const w = WEAPONS[this.weapon.id];
    const targetFov = ads ? w.adsFov : BASE_FOV;
    const fov = cam.fov + (targetFov - cam.fov) * Math.min(1, 10 * dt);
    this.render.setFov(fov);
    this.vm.resize(window.innerWidth / window.innerHeight, Math.max(32, fov * VM_FOV_RATIO));
  }

  private updateViewModel(dt: number): void {
    const speed = Math.hypot(this.local.vx, this.local.vz);
    const ads = (this.mouseButtons & 2) !== 0 && !this.dead ? 1 : 0;
    const reloadProgress =
      this.weapon.reloadDoneAt > 0
        ? 1 - (this.weapon.reloadDoneAt - this.clock) / WEAPONS[this.weapon.id].reloadMs
        : 0;
    this.vm.update(dt, {
      lookDx: this.lookDx,
      lookDy: this.lookDy,
      speed,
      grounded: this.local.grounded,
      ads,
      reloadProgress: Math.max(0, Math.min(1, reloadProgress)),
    });
    this.lookDx *= 1 - Math.min(1, 18 * dt);
    this.lookDy *= 1 - Math.min(1, 18 * dt);

    // Local footsteps.
    if (this.local.grounded && speed > 1.5 && !this.dead) {
      this.footstepT -= dt;
      if (this.footstepT <= 0) {
        this.footstepT = Math.max(0.26, 0.66 - speed * 0.042);
        this.audio.footstep(1.5, 0);
      }
    } else {
      this.footstepT = 0.12;
    }
  }

  private updateHud(dt: number): void {
    this.hud.update(dt);
    this.hud.setHealth(this.health);
    this.hud.setAmmo(this.weapon.ammo, this.serverMag, this.weapon.id, this.weapon.reloadDoneAt > 0);

    const ads = (this.mouseButtons & 2) !== 0 && !this.dead ? 1 : 0;
    const w = WEAPONS[this.weapon.id];
    const spreadRad = (ads ? w.spreadAds : w.spreadHip) + this.weapon.bloom;
    const spreadPx = Math.tan(spreadRad) * (window.innerHeight / (2 * Math.tan((this.render.camera.fov * Math.PI) / 360)));
    this.hud.drawCrosshair(Math.min(34, spreadPx), ads, this.hud.hitFade);

    if (this.dead) {
      const remain = Math.max(0, (this.respawnAt - performance.now()) / 1000);
      this.hud.setDead(true, this.lastKiller || undefined, remain);
    } else {
      this.hud.setDead(false);
    }

    this.matchRemaining = Math.max(0, this.matchRemaining - dt * 1000);
    const leader = [...this.scoreRows].sort((a, b) => b.kills - a.kills)[0];
    this.hud.setMatch(this.matchRemaining, this.matchKillLimit, this.intermission, leader);

    this.hud.setNetStat([
      this.offline ? 'offline match' : `${Math.round(this.conn.rttMs)} ms rtt`,
      `${TICK_MS.toFixed(1)} ms tick`,
      `${this.render.drawCalls} draws`,
      `${this.remotes.size + 1} players`,
    ]);

    this.hudDamage = Math.max(0, this.hudDamage - dt * 2.2);
    this.render.setDamageFlash(this.hudDamage);
  }

  // ------------------------------------------------------------------ helpers

  private distanceToCamera(x: number, y: number, z: number): number {
    const c = this.render.camera.position;
    return Math.hypot(c.x - x, c.y - y, c.z - z);
  }

  /** -1 (left) .. 1 (right) relative to where the player is looking. */
  private panFor(x: number, z: number): number {
    const dx = x - this.local.x;
    const dz = z - this.local.z;
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    const len = Math.hypot(dx, dz) || 1;
    return Math.max(-1, Math.min(1, ((dx * rightX + dz * rightZ) / len) * 0.9));
  }

  /** Screen-space angle for the damage direction indicator. */
  private screenAngleTo(x: number, z: number): number {
    const dx = x - this.local.x;
    const dz = z - this.local.z;
    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    const f = dx * forwardX + dz * forwardZ;
    const r = dx * rightX + dz * rightZ;
    return Math.atan2(r, f);
  }
}

function lerpAngleLocal(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function preventDefault(e: Event): void {
  e.preventDefault();
}
