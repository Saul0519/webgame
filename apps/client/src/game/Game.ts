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
  MAX_GROUND_SPEED,
  WALK_SCALE,
  coneSpread,
  createMoveState,
  dirFromAngles,
  fireIntervalMs,
  fireSpread,
  getMap,
  mulberry32,
  quantAngle,
  simulateMovement,
  sprayShot,
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
import { CharacterModel, setCharacterQuality } from './CharacterModel.js';
import { ViewModel } from './ViewModel.js';
import { Effects } from './Effects.js';
import { AudioEngine } from './AudioEngine.js';
import type { Hud, ScoreRow } from '../ui/Hud.js';
import { Minimap } from '../ui/Minimap.js';
import { saveSettings, tierName, type GameSettings } from '../ui/SettingsPanel.js';
import { PauseOverlay } from '../ui/PauseOverlay.js';
import { t } from '../ui/i18n.js';
import type { CrosshairConfig } from '../ui/Crosshair.js';
import { BIND_ORDER, DEFAULT_BINDS, type KeyBinds } from '../ui/Keybinds.js';

const DEFAULT_FOV = 92;
/** Radians of view rotation per pixel of raw mouse movement, at sensitivity 1. */
const RAD_PER_PX = 0.0022;
/**
 * Largest single-event mouse delta we will act on. Real motion never comes
 * close; a value above this is a pointer-lock warp or a driver hiccup, and
 * acting on it reads as the view being yanked away.
 */
const MAX_MOVE_PX = 900;
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
  /** Index within the current spray; picks the entry out of the recoil pattern. */
  sprayIndex: number;
  /** When the trigger last went off, so a pause can reset the pattern. */
  lastFireAt: number;
  shots: number;
}

/**
 * Mouse button masks, as `1 << MouseEvent.button`.
 *
 * MouseEvent.button numbers the middle button 1 and the right button 2, so the
 * bit for "aim" is 1 << 2 = 4. A literal 2 there is the middle button, which is
 * why right-click never brought the sights up.
 */
const MB_FIRE = 1 << 0;
const MB_ADS = 1 << 2;

/** Everything a match needs: the player's settings plus how to host it. */
export type GameOptions = GameSettings & {
  /** Host the match in this tab instead of connecting to a server. */
  offline?: boolean;
  /** Total participants (including you) when bots fill the match. */
  fillTo?: number;
};

export class Game {
  private readonly render: RenderSystem;
  private readonly vm: ViewModel;
  private readonly effects: Effects;
  private readonly audio = new AudioEngine();
  private readonly hud: Hud;
  private readonly minimap: Minimap;
  private readonly pause: PauseOverlay;
  private readonly settings: GameSettings;
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

  private weapon: LocalWeapon = {
    id: WeaponId.Rifle,
    ammo: WEAPONS[WeaponId.Rifle].magSize,
    nextFireAt: 0,
    reloadDoneAt: 0,
    sprayIndex: 0,
    lastFireAt: -1e9,
    shots: 0,
  };
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
  private adsSensitivity = 1;
  private pitchSign = -1;
  private mouseSmoothing = 0;
  private baseFov = DEFAULT_FOV;
  /** Buffered mouse motion, only used when smoothing is switched on. */
  private pendingDx = 0;
  private pendingDy = 0;
  /** Set when pointer lock is acquired; the first delta after that is a warp. */
  private skipNextMove = false;
  /** Set when the browser refuses pointer lock (sandboxed frames, some mobiles). */
  private lockUnavailable = false;
  /** In the fallback path the player has clicked in and wants to aim. */
  private fallbackAiming = false;
  private hovering = false;
  private chatOpen = false;
  private scoreboardOpen = false;
  private binds: KeyBinds;
  /** Reverse lookup so a keydown can be matched to an action in one step. */
  private bindLookup = new Map<string, (keyof KeyBinds)[]>();
  private wantFullscreen = true;
  /** 0..1 aim-down-sights blend, paced by the weapon's own ADS time. */
  private adsBlend = 0;
  /** 0..1 crosshair firing error, bumped per shot and decayed. */
  private fireError = 0;

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
    this.adsSensitivity = opts.adsSensitivity ?? 1;
    this.pitchSign = opts.invertY ? 1 : -1;
    this.mouseSmoothing = opts.mouseSmoothing ?? 0;
    this.baseFov = opts.fov ?? DEFAULT_FOV;
    this.binds = { ...DEFAULT_BINDS, ...(opts.binds ?? {}) };
    this.wantFullscreen = opts.fullscreen !== false;
    this.rebuildBindLookup();
    this.onDisconnect = onDisconnect;

    this.map = getMap('reactor');
    this.world = new CollisionWorld(this.map);
    this.local = createMoveState(0, 1, 0);

    this.render = new RenderSystem(container, opts.fov ?? DEFAULT_FOV);
    setCharacterQuality(opts.quality);
    this.render.applyMap(this.map, opts.quality);

    const materials = buildSurfaceMaterials(opts.quality);
    const level = buildLevel(this.map, materials);
    this.render.scene.add(level.group);

    this.vm = new ViewModel(DEFAULT_FOV * VM_FOV_RATIO);
    this.vm.setEnvironment(this.render.environment);
    this.render.setRenderScale(opts.renderScale ?? 1);
    this.render.setDynamicResolution(opts.dynamicResolution !== false);
    this.render.setQuality(opts.quality, this.vm.scene, this.vm.camera);
    this.render.resize();

    this.effects = new Effects(this.render.scene);
    this.minimap = new Minimap(hud.root, this.map);

    const handlers = {
      onWelcome: (w: { playerId: number; roster: { id: number; name: string }[] }) =>
        this.onWelcome(w.playerId, w.roster),
      onSnapshot: (s: Snapshot) => this.onSnapshot(s),
      onEvents: (e: GameEvent[]) => this.onEvents(e),
      onClose: (reason: string) => this.onDisconnect(reason),
    };
    this.offline = opts.offline === true;
    this.conn = this.offline
      ? new LocalConnection(handlers, { fillTo: opts.fillTo ?? 5, botTier: tierName(opts.botSkill) })
      : new Connection(handlers);

    this.settings = opts;
    this.pause = new PauseOverlay(
      hud.root,
      this.settings,
      (next) => this.applyLiveSettings(next),
      {
        onResume: () => {
          this.pause.hide();
          this.requestLock();
        },
        onQuit: () => {
          this.pause.hide();
          this.onDisconnect('left the match');
        },
      },
    );
    this.applyLiveSettings(opts);

    this.bindInput();
    window.addEventListener('resize', this.handleResize);
  }

  /**
   * Apply the settings that can change without restarting the match. Anything
   * the server owns (bot fill, bot skill) is deliberately absent.
   */
  applyLiveSettings(s: {
    sensitivity: number;
    adsSensitivity: number;
    invertY: boolean;
    mouseSmoothing: number;
    fov: number;
    brightness: number;
    volume: number;
    muted: boolean;
    viewmodelSway: number;
    viewBob: number;
    renderScale: number;
    dynamicResolution: boolean;
    screenEffects: boolean;
    crosshair: CrosshairConfig;
    binds: KeyBinds;
    fullscreen: boolean;
    minimapMode: number;
    showFps: boolean;
  }): void {
    this.sensitivity = s.sensitivity;
    this.adsSensitivity = s.adsSensitivity;
    this.pitchSign = s.invertY ? 1 : -1;
    this.mouseSmoothing = s.mouseSmoothing;
    this.baseFov = s.fov;
    this.render.setBrightness(s.brightness);
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.vm.setStyle(s.viewmodelSway, s.viewBob);
    this.render.setRenderScale(s.renderScale);
    this.render.setDynamicResolution(s.dynamicResolution);
    this.render.setScreenEffects(s.screenEffects);
    this.hud.setCrosshair(s.crosshair);
    this.hud.setNetStatVisible(s.showFps);
    this.minimap.setMode(s.minimapMode);
    this.binds = { ...DEFAULT_BINDS, ...s.binds };
    this.rebuildBindLookup();
    this.hud.setRespawnKey(this.binds.jump);
    this.wantFullscreen = s.fullscreen;
    // Turning the option off mid-match should hand the shortcuts straight back.
    if (!s.fullscreen && document.fullscreenElement) void this.exitFullscreen();
  }

  private rebuildBindLookup(): void {
    this.bindLookup.clear();
    for (const action of BIND_ORDER) {
      const code = this.binds[action];
      if (!code) continue;
      const list = this.bindLookup.get(code);
      if (list) list.push(action);
      else this.bindLookup.set(code, [action]);
    }
  }

  private held(action: keyof KeyBinds): boolean {
    const code = this.binds[action];
    return code !== '' && this.keys.has(code);
  }

  /** Exposed for the browser console and automated smoke tests. */
  get debug(): {
    render: RenderSystem;
    vm: ViewModel;
    local: MoveState;
    world: CollisionWorld;
    weapon: LocalWeapon;
    state: { dead: boolean; health: number; mouseButtons: number; adsBlend: number; clock: number };
  } {
    return {
      render: this.render,
      vm: this.vm,
      local: this.local,
      world: this.world,
      weapon: this.weapon,
      state: {
        dead: this.dead,
        health: this.health,
        mouseButtons: this.mouseButtons,
        adsBlend: this.adsBlend,
        clock: this.clock,
      },
    };
  }

  async connect(room: string, name: string, bots?: number, tier?: string): Promise<void> {
    await this.conn.connect(room, name, bots, tier);
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
    document.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('wheel', this.handleWheel);
    window.removeEventListener('contextmenu', preventDefault);
    void this.exitFullscreen();
    this.conn.close();
    this.pause.dispose();
    this.render.renderer.dispose();
    this.render.canvas.remove();
  }

  // -------------------------------------------------------------------- input

  private bindInput(): void {
    const canvas = this.render.canvas;
    canvas.addEventListener('click', () => {
      if (this.chatOpen || this.pause.isOpen) return;
      this.audio.ensure();
      // Fullscreen needs a user gesture, and this click is one. Ask for it here
      // rather than at match start so the request is never rejected.
      if (this.wantFullscreen) void this.enterFullscreen();
      if (this.lockUnavailable) {
        this.fallbackAiming = true;
        return;
      }
      if (document.pointerLockElement !== canvas) this.requestLock();
    });
    canvas.addEventListener('pointerenter', () => {
      this.hovering = true;
    });
    canvas.addEventListener('pointerleave', () => {
      this.hovering = false;
    });
    document.addEventListener('pointerlockchange', this.handlePointerLock);
    document.addEventListener('pointermove', this.handlePointerMove);
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

  /**
   * Ask for raw, unaccelerated deltas. Without this the OS pointer-acceleration
   * curve is applied first, so a fast flick is silently multiplied two or three
   * times over — which is exactly what a sudden sensitivity spike feels like.
   * Not every browser supports it, hence the plain retry.
   */
  private requestLock(): void {
    const canvas = this.render.canvas;
    let attempt: Promise<void> | undefined;
    try {
      attempt = canvas.requestPointerLock({ unadjustedMovement: true }) as unknown as Promise<void> | undefined;
    } catch {
      attempt = undefined;
    }
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => {
        try {
          const retry = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
          if (retry && typeof retry.catch === 'function') retry.catch(() => this.onLockUnavailable());
        } catch {
          this.onLockUnavailable();
        }
      });
    }
    // Some embedders neither resolve nor reject; if lock has not engaged shortly
    // after the click, assume it is not coming and fall back.
    window.setTimeout(() => {
      if (!this.locked && !this.disposed) this.onLockUnavailable();
    }, 700);
  }

  /**
   * Sandboxed frames can refuse pointer lock outright. Rather than leave the
   * game unplayable, aim from raw cursor motion while the pointer is over the
   * view — it is worse than a locked pointer, but it works.
   */
  private onLockUnavailable(): void {
    if (this.lockUnavailable) return;
    this.lockUnavailable = true;
    this.fallbackAiming = true;
    this.pause.hide();
    this.hud.setPointerHint(false);
    this.hud.showToast(t('toast.lockBlocked'));
  }

  /**
   * Fullscreen plus the Keyboard Lock API.
   *
   * Outside fullscreen a page cannot cancel the browser's own chords: Ctrl+W
   * closes the tab, Ctrl+D bookmarks, Ctrl+S saves. That is what makes a
   * crouch-and-move (Ctrl+W) or a crouch-and-strafe (Ctrl+A/D) close the window
   * mid-fight. Fullscreen is the one context where the browser will hand those
   * keys to the page instead, so we take it whenever the player allows it.
   */
  private async enterFullscreen(): Promise<void> {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch {
      return; // refused (iframe without the permission, or the user said no)
    }
    const kb = (navigator as Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void> } }).keyboard;
    if (!kb?.lock) return;
    try {
      await kb.lock();
    } catch {
      /* not granted; the C-for-crouch default still keeps the tab alive */
    }
  }

  private async exitFullscreen(): Promise<void> {
    const kb = (navigator as Navigator & { keyboard?: { unlock?: () => void } }).keyboard;
    try {
      kb?.unlock?.();
    } catch {
      /* nothing held */
    }
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch {
      /* already leaving */
    }
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void this.exitFullscreen();
      this.hud.showToast(t('toast.fullscreenOff'));
    } else {
      void this.enterFullscreen();
      this.hud.showToast(t('toast.fullscreenOn'));
    }
  }

  /** True when the game should be reading mouse and keyboard input. */
  private get inputActive(): boolean {
    return this.locked || (this.lockUnavailable && this.fallbackAiming && this.hovering);
  }

  private handlePointerLock = (): void => {
    if (this.lockUnavailable) return;
    if (!this.locked) {
      this.keys.clear();
      this.mouseButtons = 0;
      if (!this.chatOpen) this.pause.show();
    } else {
      this.pause.hide();
      this.skipNextMove = true;
      this.pendingDx = 0;
      this.pendingDy = 0;
      // A button left focused by the menu or the pause card still answers Space
      // and Enter with a click, so a jump would re-trigger whatever it does.
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) active.blur();
    }
    this.hud.setPointerHint(!this.locked && !this.chatOpen && !this.pause.isOpen);
  };

  /**
   * Browsers coalesce pointer events to one per frame. At low frame rates that
   * throws away real mouse samples and makes aiming feel like it arrives late,
   * so pull the sub-frame history back out where the browser offers it.
   */
  private handlePointerMove = (e: PointerEvent): void => {
    if (!this.inputActive) return;
    // Engaging pointer lock warps the cursor, and the first delta afterwards can
    // be measured from wherever it used to be — a whole screen width at worst.
    if (this.skipNextMove) {
      this.skipNextMove = false;
      return;
    }

    let dx = e.movementX;
    let dy = e.movementY;
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    if (coalesced && coalesced.length > 1) {
      let sx = 0;
      let sy = 0;
      for (const c of coalesced) {
        sx += c.movementX;
        sy += c.movementY;
      }
      // Whether a coalesced sample's movementX is relative to the previous
      // sample or to the previous dispatched event is implementation-defined.
      // The parent event's total is the one the spec pins down, so only take the
      // finer-grained samples when they agree with it.
      if (Math.abs(sx) <= Math.abs(dx) + 1 && Math.abs(sy) <= Math.abs(dy) + 1) {
        dx = sx;
        dy = sy;
      }
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    dx = Math.max(-MAX_MOVE_PX, Math.min(MAX_MOVE_PX, dx));
    dy = Math.max(-MAX_MOVE_PX, Math.min(MAX_MOVE_PX, dy));

    // Sway follows the hand, so it uses the raw delta rather than the
    // zoom-corrected or inverted one.
    this.lookDx += dx * 0.001;
    this.lookDy += dy * 0.001;

    if (this.mouseSmoothing > 0) {
      this.pendingDx += dx;
      this.pendingDy += dy;
      return;
    }
    this.applyLook(dx, dy);
  };

  /**
   * Convert a mouse delta into view angles. Zooming shrinks the angle covered by
   * the screen, so without this correction aiming down a 22-degree sniper scope
   * feels four times as sensitive as hip fire.
   */
  private applyLook(dx: number, dy: number): void {
    const baseTan = Math.tan((this.baseFov * Math.PI) / 360);
    const fovScale = Math.tan((this.render.camera.fov * Math.PI) / 360) / baseTan;
    const zoomed = fovScale < 0.995;
    const s = this.sensitivity * RAD_PER_PX * fovScale * (zoomed ? this.adsSensitivity : 1);
    this.yaw -= dx * s;
    this.pitch += dy * s * this.pitchSign;
    this.pitch = Math.max(-1.5533, Math.min(1.5533, this.pitch));
  }

  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.inputActive) return;
    // Middle-click starts autoscroll and any drag starts a text selection;
    // both survive pointer lock being released and leave the page in a state
    // the next click has to clear before it reaches the game.
    e.preventDefault();
    this.mouseButtons |= 1 << e.button;
  };

  private handleMouseUp = (e: MouseEvent): void => {
    this.mouseButtons &= ~(1 << e.button);
  };

  private handleWheel = (e: WheelEvent): void => {
    if (!this.inputActive) return;
    const order = [WeaponId.Rifle, WeaponId.SMG, WeaponId.Shotgun, WeaponId.Sniper];
    const i = order.indexOf(this.weapon.id);
    const next = order[(i + (e.deltaY > 0 ? 1 : order.length - 1)) % order.length];
    this.switchWeapon(next);
  };

  /** The first action bound to a key code, or null if the game ignores it. */
  private actionFor(code: string): keyof KeyBinds | null {
    const list = this.bindLookup.get(code);
    return list && list.length > 0 ? list[0] : null;
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (this.chatOpen) return;

    if (e.code === 'Escape' && this.lockUnavailable) {
      e.preventDefault();
      if (this.pause.isOpen) {
        this.pause.hide();
        this.fallbackAiming = true;
      } else {
        this.fallbackAiming = false;
        this.pause.show();
      }
      return;
    }

    const action = this.actionFor(e.code);
    if (action === null) return;

    // Every key the game claims is consumed here. Without this Space scrolls
    // the page and clicks whatever button still holds focus, Tab walks the
    // focus ring out of the canvas, and the digits and modifier chords reach
    // the browser's own shortcut table. Under Keyboard Lock this is also what
    // stops Ctrl+W from closing the tab.
    if (this.inputActive || action === 'fullscreen') e.preventDefault();
    // Auto-repeat must not re-fire one-shot actions; held movement keys are
    // tracked by presence in the set, so a repeat there is harmless either way.
    if (e.repeat) return;

    switch (action) {
      case 'chat':
        this.openChat();
        return;
      case 'scoreboard':
        this.scoreboardOpen = true;
        this.hud.toggleScoreboard(true);
        return;
      case 'map':
        this.settings.minimapMode = this.minimap.cycle();
        saveSettings(this.settings);
        return;
      case 'mute':
        this.settings.muted = !this.audio.isMuted;
        this.audio.setMuted(this.settings.muted);
        saveSettings(this.settings);
        this.hud.showToast(this.settings.muted ? t('toast.muted') : t('toast.unmuted'));
        return;
      case 'fullscreen':
        this.toggleFullscreen();
        return;
      case 'weapon1':
        this.switchWeapon(WeaponId.Rifle);
        return;
      case 'weapon2':
        this.switchWeapon(WeaponId.SMG);
        return;
      case 'weapon3':
        this.switchWeapon(WeaponId.Shotgun);
        return;
      case 'weapon4':
        this.switchWeapon(WeaponId.Sniper);
        return;
      default:
        break;
    }

    if (action === 'jump' && this.dead && performance.now() >= this.respawnAt) {
      this.conn.sendRespawn();
    }
    this.keys.add(e.code);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    const action = this.actionFor(e.code);
    if (action === 'scoreboard') {
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
    this.weapon = {
      id,
      ammo: WEAPONS[id].magSize,
      nextFireAt: this.clock + 350,
      reloadDoneAt: 0,
      sprayIndex: 0,
      lastFireAt: -1e9,
      shots: 0,
    };
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
            this.hud.showToast(t('toast.eliminated'));
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
            const wasDead = this.dead;
            this.local = createMoveState(ev.x, ev.y, ev.z);
            if (wasDead) {
              this.yaw = ev.yaw;
              this.pitch = 0;
            }
            this.recoilPitch = 0;
            this.recoilYaw = 0;
            this.pending.length = 0;
            this.predictionError.set(0, 0, 0);
            this.dead = false;
            this.health = MAX_HEALTH;
            this.weapon.ammo = WEAPONS[this.weapon.id].magSize;
            this.weapon.reloadDoneAt = 0;
            this.weapon.sprayIndex = 0;
            this.weapon.lastFireAt = -1e9;
            this.adsBlend = 0;
            this.fireError = 0;
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
          if (changed) this.hud.showToast(t(ev.intermission ? 'toast.matchOver' : 'toast.roundStart'));
          this.matchStateKnown = true;
          break;
        }
      }
    }
  }

  private onShotEvent(ev: Extract<GameEvent, { t: 'shot' }>): void {
    if (ev.id === this.selfId) return; // already predicted locally
    this.minimap.ping(ev.x, ev.z);
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
    // Wall clock, not an accumulator. The fixed-step loop below caps how many
    // ticks one frame may run, so on a slow machine an accumulated clock drifts
    // behind real time and the client predicts a slower rate of fire than the
    // server is actually giving it — tracers and shot sounds go missing exactly
    // where the frame rate is already worst.
    this.clock = now;

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
    this.minimap.draw(this.local.x, this.local.z, this.yaw, this.dead);
    this.updateHud(dt);

    this.render.render(dt, this.vm.scene, this.vm.camera);
  };

  /** One fixed simulation step: sample input, predict, maybe fire. */
  private tickInput(): void {
    if (this.mouseSmoothing > 0 && (this.pendingDx !== 0 || this.pendingDy !== 0)) {
      const take = 1 - this.mouseSmoothing;
      const dx = this.pendingDx * take;
      const dy = this.pendingDy * take;
      this.pendingDx -= dx;
      this.pendingDy -= dy;
      if (Math.abs(this.pendingDx) < 1e-3) this.pendingDx = 0;
      if (Math.abs(this.pendingDy) < 1e-3) this.pendingDy = 0;
      this.applyLook(dx, dy);
    }
    const buttons = this.gatherButtons();
    let forward = (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0);
    let rightRaw = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    // Normalise before scaling. The shared sim only normalises when the vector
    // is longer than 1, so a pre-scaled diagonal (0.45, 0.45) slips through at
    // length 0.64 and walks 41% faster diagonally than straight — which now
    // also reads as "walking is accurate, except diagonally".
    const axisLen = Math.hypot(forward, rightRaw);
    if (axisLen > 1) {
      forward /= axisLen;
      rightRaw /= axisLen;
    }
    const walk = this.held('walk') ? WALK_SCALE : 1;

    // Recoil recovery pulls the view back toward where the player was aiming —
    // but only once the trigger is off. Gate it on the trigger rather than on a
    // timer: a rifle fires every 103 ms, so any fixed window short enough to
    // feel responsive also expires between every pair of shots and cancels the
    // climb the pattern is supposed to produce.
    const w = WEAPONS[this.weapon.id];
    if ((buttons & Btn.Fire) === 0) {
      const rec = Math.min(1, w.recoilRecovery * TICK_DT);
      this.pitch -= this.recoilPitch * rec;
      this.yaw -= this.recoilYaw * rec;
      this.recoilPitch *= 1 - rec;
      this.recoilYaw *= 1 - rec;
      this.pitch = Math.max(-1.5533, Math.min(1.5533, this.pitch));
    }

    const input: WireInput = {
      seq: this.inputSeq++,
      buttons,
      // Quantise exactly as the wire will, so prediction simulates the same
      // numbers the server decodes instead of drifting by a rounding step.
      forward: this.dead ? 0 : quantAxis(forward * walk),
      right: this.dead ? 0 : quantAxis(rightRaw * walk),
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
    if (this.held('jump')) b |= Btn.Jump;
    if (this.held('crouch')) b |= Btn.Crouch;
    if ((this.mouseButtons & MB_FIRE) !== 0) b |= Btn.Fire;
    if ((this.mouseButtons & MB_ADS) !== 0) b |= Btn.Ads;
    if (this.held('walk')) b |= Btn.Sprint;
    if (this.held('reload')) b |= Btn.Reload;
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
    if ((buttons & Btn.Reload) !== 0 && s.reloadDoneAt === 0 && s.ammo < w.magSize) {
      s.reloadDoneAt = this.clock + w.reloadMs;
      this.vm.onReload();
      this.audio.reload('out');
    }

    if ((buttons & Btn.Fire) === 0) {
      // Same rule as the server: trigger release, not a timer, is what resets
      // the pattern, so both sides index the same entry for the same shot.
      s.sprayIndex = 0;
      return;
    }
    if (s.reloadDoneAt > 0 || this.clock < s.nextFireAt) return;
    if (s.ammo <= 0) {
      s.reloadDoneAt = this.clock + w.reloadMs;
      this.vm.onReload();
      this.audio.reload('out');
      return;
    }

    // Let go of the trigger for long enough and the pattern starts over. This
    // has to match the server's rule exactly or the predicted tracers drift
    // away from where the shots actually went.
    if (this.clock - s.lastFireAt > w.sprayResetMs) s.sprayIndex = 0;
    s.lastFireAt = this.clock;

    s.ammo--;
    s.nextFireAt = this.clock + fireIntervalMs(w);
    s.shots = (s.shots + 1) & 0xffff;

    const ads = (buttons & Btn.Ads) !== 0;
    const spread = fireSpread(w, {
      speed: Math.hypot(this.local.vx, this.local.vz),
      grounded: this.local.grounded,
      crouching: this.local.crouching,
      ads,
      sprayIndex: s.sprayIndex,
    });
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
    // Fixed recoil pattern: the same shot index always kicks the same way, so
    // the spray can be learned and countered rather than fought.
    const kick = sprayShot(w, s.sprayIndex);
    const kickScale = ads ? w.adsRecoilScale : 1;
    const before = this.pitch;
    // Symmetric so a future weapon with downward kick cannot escape the clamp.
    this.pitch = Math.max(-1.5533, Math.min(1.5533, this.pitch + kick.up * kickScale));
    // Mirror the clamp into the debt so recovery cannot pay back a kick that was
    // never applied — that shows up as the view sinking while firing upward.
    this.recoilPitch += this.pitch - before;
    const side = kick.side * kickScale;
    this.recoilYaw += side;
    this.yaw += side;

    s.sprayIndex++;
    this.fireError = Math.min(1, this.fireError + 0.42);
    this.vm.onFire(kick.up * 55);
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

    // Each weapon states how long it takes to come up, so a scoped rifle is a
    // real commitment and an SMG barely is.
    const want = (this.mouseButtons & MB_ADS) !== 0 && !this.dead ? 1 : 0;
    const w = WEAPONS[this.weapon.id];
    const rate = 1000 / Math.max(60, w.adsTimeMs);
    this.adsBlend += (want - this.adsBlend) * Math.min(1, rate * dt);
    if (this.adsBlend < 1e-3) this.adsBlend = 0;
    const ease = this.adsBlend * this.adsBlend * (3 - 2 * this.adsBlend);
    const fov = this.baseFov + (w.adsFov - this.baseFov) * ease;
    this.render.setFov(fov);
    this.vm.resize(window.innerWidth / window.innerHeight, Math.max(32, fov * VM_FOV_RATIO));

    // The scope only irises in over the back half of the animation, so the
    // rifle is visibly coming up before the glass takes the screen.
    const scope = w.scoped ? Math.max(0, Math.min(1, (ease - 0.45) / 0.55)) : 0;
    this.hud.drawScope(scope, this.lookDx * -260, this.lookDy * -180);
    // Nothing behind the glass is worth the fill rate, and a rifle body poking
    // through the scope surround is the classic giveaway.
    this.vm.setVisible(scope < 0.92);
  }

  private updateViewModel(dt: number): void {
    const speed = Math.hypot(this.local.vx, this.local.vz);
    const ads = this.adsBlend;
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

    // The crosshair reports the two penalties the player can actually act on:
    // how fast they are moving, and how deep into a spray they are.
    this.fireError = Math.max(0, this.fireError - dt * 2.6);
    const speed = Math.hypot(this.local.vx, this.local.vz);
    const speedT = Math.min(1, speed / MAX_GROUND_SPEED);
    const moveError = this.local.grounded ? speedT * speedT * speedT : 1;
    this.hud.drawCrosshair({
      moveError: this.dead ? 0 : moveError,
      fireError: this.fireError,
      ads: this.adsBlend,
      hit: this.hud.hitFade,
    });

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
      `${this.render.fps} fps  ${Math.round(this.render.resolutionScale * 100)}%`,
      this.offline ? t('hud.offlineMatch') : t('hud.rtt', { n: Math.round(this.conn.rttMs) }),
      t('hud.tick', { ms: TICK_MS.toFixed(1), draws: this.render.drawCalls }),
      this.remotes.size === 0 ? t('hud.playerCountOne') : t('hud.playerCount', { n: this.remotes.size + 1 }),
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

/** Matches the i8/127 encoding in the input packet. */
function quantAxis(v: number): number {
  return Math.round(Math.max(-1, Math.min(1, v)) * 127) / 127;
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
