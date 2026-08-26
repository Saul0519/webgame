import {
  Btn,
  INTERP_DELAY_MS,
  LAGCOMP_HISTORY_MS,
  LAGCOMP_MAX_REWIND_MS,
  MAX_HEALTH,
  MAX_INPUT_BACKLOG,
  MAX_PLAYERS_PER_ROOM,
  NAME_MAX_LEN,
  PFlag,
  RESPAWN_DELAY_MS,
  SNAPSHOT_EVERY,
  SPAWN_PROTECTION_MS,
  TICK_MS,
} from './constants.js';
import { CollisionWorld } from './collision.js';
import { HitPart, raycastPlayer } from './hitbox.js';
import { DEFAULT_MAP_ID, getMap, pickSpawn, type GameMap } from './map.js';
import { coneSpread, dirFromAngles, mulberry32, type Vec3 } from './math.js';
import { createMoveState, simulateMovement, type MoveState } from './movement.js';
import { NavGraph } from './nav.js';
import {
  C2S,
  Ev,
  Reader,
  S2C,
  Writer,
  packAngle,
  packUnit,
  packVel,
  readInputs,
  type WireInput,
} from './protocol.js';
import { WEAPONS, WeaponId, damageAtRange, fireIntervalMs, fireSpread } from './weapons.js';
import {
  botName,
  botThink,
  createBrain,
  tierByName,
  type BotBrain,
  type BotEnemy,
  type BotSelf,
  type BotTier,
  type BotTierName,
  type BotView,
} from './bot.js';

export const KILL_LIMIT = 30;
export const MATCH_TIME_MS = 10 * 60 * 1000;
const INTERMISSION_MS = 12_000;
const IDLE_KICK_MS = 45_000;
/** Inputs consumed per tick when a client is behind; keeps catch-up bounded. */
const MAX_CATCHUP_INPUTS = 3;
/** Bots re-evaluate on this cadence; in between they repeat their last input. */
const BOT_THINK_EVERY = 2;

const CTRL_CHARS = /[\u0000-\u001f\u007f]/g;
// Control characters and angle brackets, plus the invisible ones: zero-width
// joiners, the Hangul fillers (U+115F/U+1160/U+3164) and the ideographic
// space all render as nothing, so a name made of them is a nameless player.
const NAME_BAD_CHARS = /[\u0000-\u001f\u007f<>\u00ad\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u3000\u3164\ufeff]/g;

/** Anything that can carry bytes to one connected client. */
export interface RoomTransport {
  send(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface RoomOptions {
  mapId?: string;
  maxPlayers?: number;
  /** Fill the match with bots up to this many total participants. */
  fillTo?: number;
  /** Difficulty tier for the bots in this room. */
  botTier?: BotTierName;
  seed?: number;
}

interface HistorySample {
  t: number;
  x: number;
  y: number;
  z: number;
  crouch: boolean;
}

interface RoomPlayer {
  id: number;
  name: string;
  /** null for bots. */
  transport: RoomTransport | null;
  brain: BotBrain | null;
  move: MoveState;
  yaw: number;
  pitch: number;
  health: number;
  alive: boolean;
  respawnAt: number;
  protectedUntil: number;
  weapon: WeaponId;
  ammo: number;
  reloadDoneAt: number;
  nextFireAt: number;
  /** Index within the current spray; drives both the pattern and the bloom. */
  sprayIndex: number;
  /** Timestamp of the last shot, so a pause can reset the spray. */
  lastFireAt: number;
  shotCount: number;
  kills: number;
  deaths: number;
  score: number;
  streak: number;
  rewindMs: number;
  lastSeq: number;
  inputs: WireInput[];
  lastInput: WireInput | null;
  history: HistorySample[];
  lastPacketAt: number;
  joined: boolean;
}

interface PendingEvent {
  /** 0 = broadcast, otherwise only this player id receives it. */
  to: number;
  write: (w: Writer) => void;
}

/**
 * The authoritative match simulation, with no knowledge of how bytes reach a
 * client. A Cloudflare Durable Object wraps it around real WebSockets; the
 * browser build wraps it around an in-process loopback so the same server code
 * can host an offline practice match.
 */
export class MatchRoom {
  readonly map: GameMap;
  readonly world: CollisionWorld;
  readonly nav: NavGraph;

  private readonly players = new Map<number, RoomPlayer>();
  private readonly maxPlayers: number;
  private fillTo: number;
  private botTier: BotTier;

  private tickNo = 0;
  private timeMs = 0;
  private lastRealMs = 0;
  private started = false;
  private events: PendingEvent[] = [];
  private nextId = 1;
  private botsSpawned = 0;
  private rngState: number;

  private matchEndsAt = MATCH_TIME_MS;
  private intermissionUntil = 0;

  private readonly botEnemies: BotEnemy[] = [];
  private readonly botSelf: BotSelf = {
    x: 0, y: 0, z: 0, eye: 0, health: 0, ammo: 0,
    weapon: WeaponId.Rifle, reloading: false, grounded: false, speed: 0,
  };
  private readonly botView: BotView;

  constructor(opts: RoomOptions = {}) {
    this.map = getMap(opts.mapId ?? DEFAULT_MAP_ID);
    this.world = new CollisionWorld(this.map);
    this.nav = new NavGraph(this.world, this.map);
    this.maxPlayers = opts.maxPlayers ?? MAX_PLAYERS_PER_ROOM;
    this.fillTo = Math.min(opts.fillTo ?? 0, this.maxPlayers);
    this.botTier = tierByName(opts.botTier ?? 'regular');
    this.rngState = (opts.seed ?? 0x9e3779b9) >>> 0;
    this.botView = {
      timeMs: 0,
      dtSec: (TICK_MS * BOT_THINK_EVERY) / 1000,
      world: this.world,
      nav: this.nav,
      self: this.botSelf,
      enemies: this.botEnemies,
    };
  }

  private rand(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ------------------------------------------------------------------- status

  get humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.transport) n++;
    return n;
  }

  get playerCount(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.humanCount >= this.maxPlayers;
  }

  /**
   * How many participants bots should top the match up to. Whoever opens an
   * empty room picks this, so "no bots" is a real option without needing a
   * separate room type.
   */
  setFillTo(n: number): void {
    const next = Math.max(0, Math.min(n, this.maxPlayers));
    if (next === this.fillTo) return;
    this.fillTo = next;
    this.syncBots();
  }

  /** Difficulty for bots spawned from now on. Existing bots keep theirs. */
  setBotTier(name: BotTierName | undefined): void {
    this.botTier = tierByName(name);
  }

  get botTierName(): BotTierName {
    return this.botTier.name;
  }

  get botCount(): number {
    return this.players.size - this.humanCount;
  }

  get fillTarget(): number {
    return this.fillTo;
  }

  info(): Record<string, unknown> {
    return {
      players: this.humanCount,
      bots: this.players.size - this.humanCount,
      maxPlayers: this.maxPlayers,
      map: this.map.id,
      mapName: this.map.name,
      botTier: this.botTier.name,
      inProgress: this.humanCount > 0,
    };
  }

  // ------------------------------------------------------------------ joining

  /** Add a connected client. Returns its player id, or null when the room is full. */
  join(transport: RoomTransport, rawName: string): number | null {
    if (this.isFull) return null;
    const p = this.spawnParticipant(sanitiseName(rawName), transport, null);
    this.sendWelcome(p);
    this.pushEvent(0, (w) => {
      w.u8(Ev.Join).u8(p.id).str(p.name);
    });
    // Private spawn event: the client needs the spawn yaw to orient its view.
    this.emitSpawn(p, p.id);
    this.pushScoreboard();
    this.pushMatchState(p.id);
    this.syncBots();
    return p.id;
  }

  leave(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.pushEvent(0, (w) => {
      w.u8(Ev.Leave).u8(id);
    });
    this.pushScoreboard();
    this.syncBots();
  }

  private spawnParticipant(name: string, transport: RoomTransport | null, brain: BotBrain | null): RoomPlayer {
    const id = this.allocId();
    const spawn = pickSpawn(this.map, this.livingPositions(), () => this.rand());
    const p: RoomPlayer = {
      id,
      name: name || (transport ? `Player ${id}` : botName(this.botsSpawned)),
      transport,
      brain,
      move: createMoveState(spawn.pos[0], spawn.pos[1], spawn.pos[2]),
      yaw: spawn.yaw,
      pitch: 0,
      health: MAX_HEALTH,
      alive: true,
      respawnAt: 0,
      protectedUntil: this.timeMs + SPAWN_PROTECTION_MS,
      weapon: WeaponId.Rifle,
      ammo: WEAPONS[WeaponId.Rifle].magSize,
      reloadDoneAt: 0,
      nextFireAt: 0,
      sprayIndex: 0,
      lastFireAt: -1e9,
      shotCount: 0,
      kills: 0,
      deaths: 0,
      score: 0,
      streak: 0,
      rewindMs: INTERP_DELAY_MS,
      lastSeq: 0,
      inputs: [],
      lastInput: null,
      history: [],
      lastPacketAt: this.timeMs,
      joined: false,
    };
    if (brain) brain.yaw = spawn.yaw;
    this.players.set(id, p);
    return p;
  }

  /** Keep the match topped up with bots while at least one human is present. */
  private syncBots(): void {
    const humans = this.humanCount;
    const target = humans > 0 ? Math.max(0, this.fillTo - humans) : 0;
    const bots = [...this.players.values()].filter((p) => !p.transport);

    for (let i = bots.length; i < target; i++) {
      const name = botName(this.botsSpawned++);
      const brain = createBrain(name, this.botTier, 0, () => this.rand());
      const p = this.spawnParticipant(name, null, brain);
      p.weapon = [WeaponId.Rifle, WeaponId.Rifle, WeaponId.SMG, WeaponId.Shotgun, WeaponId.Sniper][
        Math.floor(this.rand() * 5)
      ];
      p.ammo = WEAPONS[p.weapon].magSize;
      this.pushEvent(0, (w) => {
        w.u8(Ev.Join).u8(p.id).str(p.name);
      });
    }
    for (let i = bots.length - 1; i >= target; i--) {
      const bot = bots[i];
      this.players.delete(bot.id);
      this.pushEvent(0, (w) => {
        w.u8(Ev.Leave).u8(bot.id);
      });
    }
  }

  private allocId(): number {
    for (let i = 0; i < 256; i++) {
      const id = ((this.nextId + i - 1) % 255) + 1;
      if (!this.players.has(id)) {
        this.nextId = (id % 255) + 1;
        return id;
      }
    }
    return 1;
  }

  private livingPositions(): Vec3[] {
    const out: Vec3[] = [];
    for (const p of this.players.values()) {
      if (p.alive) out.push({ x: p.move.x, y: p.move.y, z: p.move.z });
    }
    return out;
  }

  // ----------------------------------------------------------------- messages

  message(id: number, data: ArrayBuffer | ArrayBufferView | string): void {
    const p = this.players.get(id);
    if (!p || typeof data === 'string') return;
    p.lastPacketAt = this.timeMs;
    const r = new Reader(data);
    while (!r.eof) {
      const type = r.u8();
      switch (type) {
        case C2S.Hello: {
          const name = sanitiseName(r.str());
          if (name && !p.joined) p.name = name;
          p.joined = true;
          this.pushScoreboard();
          break;
        }
        case C2S.Input: {
          const { inputs, renderDelayMs } = readInputs(r);
          p.rewindMs = Math.min(renderDelayMs, LAGCOMP_MAX_REWIND_MS);
          for (const inp of inputs) {
            if (inp.seq <= p.lastSeq) continue;
            if (p.inputs.length >= MAX_INPUT_BACKLOG) p.inputs.shift();
            p.inputs.push(inp);
          }
          break;
        }
        case C2S.Ping: {
          const clientTime = r.f64();
          const w = new Writer(32);
          w.u8(S2C.Pong).f64(clientTime).f64(this.wallClock()).u32(this.tickNo);
          this.send(p, w.finish());
          break;
        }
        case C2S.Respawn: {
          if (!p.alive && this.timeMs >= p.respawnAt) this.respawn(p);
          break;
        }
        case C2S.Chat: {
          // Slice by code point, so a Korean or emoji message is cut between
          // characters rather than through one.
          const text = [...r.str()].slice(0, 120).join('').replace(CTRL_CHARS, '');
          if (text.trim().length === 0) break;
          this.pushEvent(0, (w) => {
            w.u8(Ev.Chat).u8(p.id).str(text);
          });
          break;
        }
        case C2S.SwitchWeapon: {
          const id2 = r.u8() as WeaponId;
          if (WEAPONS[id2] && id2 !== p.weapon) {
            p.weapon = id2;
            p.ammo = WEAPONS[id2].magSize;
            p.reloadDoneAt = 0;
            p.nextFireAt = this.timeMs + 350;
            p.sprayIndex = 0;
            p.lastFireAt = -1e9;
          }
          break;
        }
        default:
          return; // unknown opcode: the rest of the frame can't be trusted
      }
    }
  }

  /** Overridable so an offline host can supply a monotonic clock. */
  protected wallClock(): number {
    return Date.now();
  }

  private send(p: RoomPlayer, buf: ArrayBuffer): void {
    if (!p.transport) return;
    try {
      p.transport.send(buf);
    } catch {
      this.leave(p.id);
    }
  }

  private sendWelcome(p: RoomPlayer): void {
    const w = new Writer(256);
    w.u8(S2C.Welcome);
    w.u8(p.id);
    w.str(this.map.id);
    w.u32(this.tickNo);
    w.f64(this.wallClock());
    w.u8(this.players.size);
    for (const o of this.players.values()) {
      w.u8(o.id).str(o.name).u16(o.kills).u16(o.deaths);
    }
    this.send(p, w.finish());
  }

  // ---------------------------------------------------------------- tick loop

  /**
   * Advance the simulation to `nowMs` (wall clock). Safe to call more often than
   * the tick rate; catch-up is bounded so a stalled host can never spiral.
   */
  pump(nowMs: number): void {
    if (!this.started) {
      this.started = true;
      this.lastRealMs = nowMs;
    }
    let elapsed = nowMs - this.lastRealMs;
    if (elapsed > 500) elapsed = 500; // long stall: drop the backlog
    let steps = 0;
    while (elapsed >= TICK_MS && steps < 8) {
      this.tick();
      elapsed -= TICK_MS;
      steps++;
    }
    this.lastRealMs = nowMs - elapsed;
  }

  private tick(): void {
    this.tickNo++;
    this.timeMs += TICK_MS;

    for (const p of this.players.values()) {
      if (p.brain) this.driveBot(p);
    }
    for (const p of this.players.values()) {
      this.stepPlayer(p);
    }
    for (const p of this.players.values()) {
      this.recordHistory(p);
    }

    this.updateMatch();

    if (this.tickNo % SNAPSHOT_EVERY === 0) {
      this.broadcastSnapshot();
      this.flushEvents();
    }

    if (this.tickNo % 64 === 0) {
      for (const p of [...this.players.values()]) {
        if (p.transport && this.timeMs - p.lastPacketAt > IDLE_KICK_MS) {
          try {
            p.transport.close(4000, 'idle');
          } catch {
            /* already gone */
          }
          this.leave(p.id);
        }
      }
      this.pushScoreboard();
      this.pushMatchState();
    }
  }

  // ---------------------------------------------------------------------- AI

  private driveBot(p: RoomPlayer): void {
    const brain = p.brain!;
    if (!p.alive) {
      p.inputs.length = 0;
      return;
    }
    if (this.tickNo % BOT_THINK_EVERY !== p.id % BOT_THINK_EVERY) {
      // Off-cycle: repeat the previous decision so movement stays smooth.
      if (p.lastInput) p.inputs.push({ ...p.lastInput, seq: p.lastSeq + 1 });
      return;
    }

    this.botEnemies.length = 0;
    // Humans render remote players INTERP_DELAY_MS in the past on top of their
    // own ping. Sampling live positions here would hand bots an information
    // advantage no player can ever have, so they get a delayed view too.
    const seenAt = this.timeMs - brain.tier.viewLatencyMs;
    for (const o of this.players.values()) {
      if (o.id === p.id) continue;
      const h = sampleHistory(o, seenAt);
      this.botEnemies.push({ id: o.id, x: h.x, y: h.y, z: h.z, alive: o.alive });
    }
    this.botSelf.x = p.move.x;
    this.botSelf.y = p.move.y;
    this.botSelf.z = p.move.z;
    this.botSelf.eye = p.move.eye;
    this.botSelf.health = p.health;
    this.botSelf.ammo = p.ammo;
    this.botSelf.weapon = p.weapon;
    this.botSelf.reloading = p.reloadDoneAt > 0;
    this.botSelf.grounded = p.move.grounded;
    this.botSelf.speed = Math.hypot(p.move.vx, p.move.vz);
    this.botView.timeMs = this.timeMs;

    const input = botThink(brain, this.botView, () => this.rand(), p.lastSeq + 1);
    p.inputs.push(input);
    if (p.inputs.length > MAX_INPUT_BACKLOG) p.inputs.shift();
  }

  // ------------------------------------------------------------------ players

  private stepPlayer(p: RoomPlayer): void {
    const w = WEAPONS[p.weapon];

    if (!p.alive) {
      p.inputs.length = 0;
      if (this.timeMs >= p.respawnAt) this.respawn(p);
      return;
    }

    if (p.reloadDoneAt > 0 && this.timeMs >= p.reloadDoneAt) {
      p.reloadDoneAt = 0;
      p.ammo = w.magSize;
    }

    // Consume queued inputs; if the client is starved we apply a neutral input
    // so the sim keeps advancing but nothing fires on their behalf.
    let consumed = 0;
    const budget = p.inputs.length > 4 ? MAX_CATCHUP_INPUTS : 1;
    while (consumed < budget && p.inputs.length > 0) {
      const inp = p.inputs.shift()!;
      p.lastSeq = inp.seq;
      p.lastInput = inp;
      this.applyInput(p, inp);
      consumed++;
    }
    if (consumed === 0) {
      const held = p.lastInput;
      this.applyInput(
        p,
        {
          seq: p.lastSeq,
          buttons: held ? held.buttons & Btn.Crouch : 0,
          forward: 0,
          right: 0,
          yaw: p.yaw,
          pitch: p.pitch,
        },
        true,
      );
    }

    if (p.move.y < this.map.killZ) {
      this.kill(p, p, true);
    }
  }

  private applyInput(p: RoomPlayer, inp: WireInput, synthetic = false): void {
    p.yaw = inp.yaw;
    p.pitch = Math.max(-1.5533, Math.min(1.5533, inp.pitch));

    simulateMovement(
      p.move,
      {
        forward: Math.max(-1, Math.min(1, inp.forward)),
        right: Math.max(-1, Math.min(1, inp.right)),
        yaw: p.yaw,
        pitch: p.pitch,
        buttons: inp.buttons,
      },
      this.world,
    );

    if (synthetic) return;

    const w = WEAPONS[p.weapon];

    if ((inp.buttons & Btn.Reload) !== 0 && p.reloadDoneAt === 0 && p.ammo < w.magSize) {
      p.reloadDoneAt = this.timeMs + w.reloadMs;
    }

    if ((inp.buttons & Btn.Fire) !== 0) {
      this.tryFire(p, (inp.buttons & Btn.Ads) !== 0);
    } else {
      // Letting go of the trigger resets the pattern. Keyed on the input stream
      // rather than a clock, so the client and the server always agree on which
      // entry of the spray a given shot used.
      p.sprayIndex = 0;
    }
  }

  // ------------------------------------------------------------------- combat

  private tryFire(p: RoomPlayer, ads: boolean): void {
    const w = WEAPONS[p.weapon];
    if (p.reloadDoneAt > 0) return;
    if (this.timeMs < p.nextFireAt) return;
    if (p.ammo <= 0) {
      p.reloadDoneAt = this.timeMs + w.reloadMs;
      return;
    }

    // A gap in the trigger pull is what resets the pattern, so tapping is
    // always accurate and holding the button is what costs you.
    if (this.timeMs - p.lastFireAt > w.sprayResetMs) p.sprayIndex = 0;
    p.lastFireAt = this.timeMs;

    p.ammo--;
    p.nextFireAt = this.timeMs + fireIntervalMs(w);
    p.shotCount = (p.shotCount + 1) & 0xffff;
    p.protectedUntil = 0; // shooting drops spawn protection

    const eyeX = p.move.x;
    const eyeY = p.move.y + p.move.eye;
    const eyeZ = p.move.z;

    const base: Vec3 = { x: 0, y: 0, z: 0 };
    dirFromAngles(p.yaw, p.pitch, base);

    const spread = fireSpread(w, {
      speed: Math.hypot(p.move.vx, p.move.vz),
      grounded: p.move.grounded,
      crouching: p.move.crouching,
      ads,
      sprayIndex: p.sprayIndex,
    });
    const rng = mulberry32((p.id << 20) ^ (p.shotCount * 0x9e3779b1));

    const rewind = Math.min(Math.max(p.rewindMs, 0), LAGCOMP_MAX_REWIND_MS);
    const rewindTime = this.timeMs - rewind;

    const first: Vec3 = { x: base.x, y: base.y, z: base.z };
    for (let i = 0; i < w.pellets; i++) {
      const dir: Vec3 = { x: 0, y: 0, z: 0 };
      coneSpread(base, spread, rng, dir);
      if (i === 0) {
        first.x = dir.x;
        first.y = dir.y;
        first.z = dir.z;
      }
      this.resolvePellet(p, w.id, eyeX, eyeY, eyeZ, dir, rewindTime);
    }

    p.sprayIndex++;

    const pid = p.id;
    const wid = p.weapon;
    const pellets = w.pellets;
    this.pushEvent(0, (out) => {
      out
        .u8(Ev.Shot)
        .u8(pid)
        .u8(wid)
        .f32(eyeX)
        .f32(eyeY)
        .f32(eyeZ)
        .i16(packUnit(first.x))
        .i16(packUnit(first.y))
        .i16(packUnit(first.z))
        .u8(pellets);
    });
  }

  private resolvePellet(
    shooter: RoomPlayer,
    weapon: WeaponId,
    ox: number,
    oy: number,
    oz: number,
    dir: Vec3,
    rewindTime: number,
  ): void {
    const w = WEAPONS[weapon];
    const MAX_RANGE = 300;

    const worldHit = this.world.raycast(ox, oy, oz, dir.x, dir.y, dir.z, MAX_RANGE);
    let closestT = worldHit ? worldHit.t : MAX_RANGE;
    let victim: RoomPlayer | null = null;
    let part: HitPart = HitPart.Body;

    for (const other of this.players.values()) {
      if (other === shooter || !other.alive) continue;
      if (other.protectedUntil > this.timeMs) continue;
      const s = sampleHistory(other, rewindTime);
      const hit = raycastPlayer(ox, oy, oz, dir.x, dir.y, dir.z, s.x, s.y, s.z, s.crouch, closestT);
      if (hit && hit.t < closestT) {
        closestT = hit.t;
        victim = other;
        part = hit.part;
      }
    }

    if (victim) {
      let dmg = damageAtRange(w, closestT);
      if (part === HitPart.Head) dmg *= w.headMultiplier;
      else if (part === HitPart.Legs) dmg *= w.legMultiplier;
      dmg = Math.max(1, Math.round(dmg));

      victim.health -= dmg;
      const px = ox + dir.x * closestT;
      const py = oy + dir.y * closestT;
      const pz = oz + dir.z * closestT;
      const killed = victim.health <= 0;
      const vid = victim.id;
      const sid = shooter.id;
      const hitPart = part;

      // Hitmarker for the shooter only.
      this.pushEvent(sid, (out) => {
        out.u8(Ev.Hit).u8(vid).u8(hitPart).u8(Math.min(255, dmg)).u8(killed ? 1 : 0).f32(px).f32(py).f32(pz);
      });
      // Damage-direction indicator for the victim only (points at the shooter).
      this.pushEvent(vid, (out) => {
        out.u8(Ev.Hit).u8(vid).u8(hitPart).u8(Math.min(255, dmg)).u8(killed ? 1 : 0).f32(ox).f32(oy).f32(oz);
      });

      if (killed) this.kill(victim, shooter, false);
      return;
    }

    if (worldHit) {
      const px = ox + dir.x * worldHit.t;
      const py = oy + dir.y * worldHit.t;
      const pz = oz + dir.z * worldHit.t;
      const surf = this.world.brushes[worldHit.brush].surf;
      const nx = worldHit.nx;
      const ny = worldHit.ny;
      const nz = worldHit.nz;
      this.pushEvent(0, (out) => {
        out
          .u8(Ev.Impact)
          .f32(px)
          .f32(py)
          .f32(pz)
          .i8(Math.round(nx * 127))
          .i8(Math.round(ny * 127))
          .i8(Math.round(nz * 127))
          .u8(surf);
      });
    }
  }

  private kill(victim: RoomPlayer, killer: RoomPlayer, selfInflicted: boolean): void {
    if (!victim.alive) return;
    victim.alive = false;
    victim.health = 0;
    victim.deaths++;
    victim.streak = 0;
    victim.respawnAt = this.timeMs + RESPAWN_DELAY_MS;
    victim.move.vx = 0;
    victim.move.vy = 0;
    victim.move.vz = 0;
    if (victim.brain) {
      victim.brain.targetId = 0;
      victim.brain.hasLastSeen = false;
      victim.brain.wasVisible = false;
      victim.brain.path.length = 0;
    }

    if (!selfInflicted && killer !== victim) {
      killer.kills++;
      killer.streak++;
      killer.score += 100 + Math.max(0, killer.streak - 1) * 10;
    } else {
      victim.score = Math.max(0, victim.score - 50);
    }

    const kid = selfInflicted ? 0 : killer.id;
    const vid = victim.id;
    const wid = killer.weapon;
    this.pushEvent(0, (w) => {
      w.u8(Ev.Kill).u8(kid).u8(vid).u8(wid).u8(selfInflicted ? 1 : 0);
    });
    this.pushScoreboard();
  }

  private respawn(p: RoomPlayer): void {
    const spawn = pickSpawn(this.map, this.livingPositions(), () => this.rand());
    p.move = createMoveState(spawn.pos[0], spawn.pos[1], spawn.pos[2]);
    p.yaw = spawn.yaw;
    p.pitch = 0;
    p.health = MAX_HEALTH;
    p.alive = true;
    p.protectedUntil = this.timeMs + SPAWN_PROTECTION_MS;
    p.ammo = WEAPONS[p.weapon].magSize;
    p.reloadDoneAt = 0;
    p.sprayIndex = 0;
    p.lastFireAt = -1e9;
    p.history.length = 0;
    if (p.brain) {
      p.brain.yaw = spawn.yaw;
      p.brain.pitch = 0;
      p.brain.path.length = 0;
      p.brain.repathAt = 0;
    }
    this.emitSpawn(p, 0);
  }

  private emitSpawn(p: RoomPlayer, to: number): void {
    const id = p.id;
    const yaw = p.yaw;
    const x = p.move.x;
    const y = p.move.y;
    const z = p.move.z;
    this.pushEvent(to, (w) => {
      w.u8(Ev.Spawn).u8(id).f32(x).f32(y).f32(z).i16(packAngle(yaw));
    });
  }

  private updateMatch(): void {
    if (this.intermissionUntil > 0) {
      if (this.timeMs >= this.intermissionUntil) {
        this.intermissionUntil = 0;
        this.matchEndsAt = this.timeMs + MATCH_TIME_MS;
        for (const p of this.players.values()) {
          p.kills = 0;
          p.deaths = 0;
          p.score = 0;
          p.streak = 0;
          this.respawn(p);
        }
        this.pushMatchState();
        this.pushScoreboard();
      }
      return;
    }

    let leader: RoomPlayer | null = null;
    for (const p of this.players.values()) {
      if (!leader || p.kills > leader.kills) leader = p;
    }
    if ((leader && leader.kills >= KILL_LIMIT) || this.timeMs >= this.matchEndsAt) {
      this.intermissionUntil = this.timeMs + INTERMISSION_MS;
      this.pushMatchState();
    }
  }

  // ------------------------------------------------------------------ history

  private recordHistory(p: RoomPlayer): void {
    p.history.push({ t: this.timeMs, x: p.move.x, y: p.move.y, z: p.move.z, crouch: p.move.crouching });
    const cutoff = this.timeMs - LAGCOMP_HISTORY_MS;
    while (p.history.length > 2 && p.history[0].t < cutoff) p.history.shift();
  }

  // ------------------------------------------------------------------ sending

  private pushEvent(to: number, write: (w: Writer) => void): void {
    this.events.push({ to, write });
  }

  private pushScoreboard(): void {
    const rows = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      kills: p.kills,
      deaths: p.deaths,
      score: p.score,
      ping: p.transport ? Math.min(999, Math.round(p.rewindMs)) : 0,
    }));
    this.pushEvent(0, (w) => {
      w.u8(Ev.Score).u8(rows.length);
      for (const r of rows) {
        w.u8(r.id).str(r.name).u16(r.kills).u16(r.deaths).u32(r.score).u16(r.ping);
      }
    });
  }

  private pushMatchState(to = 0): void {
    const remaining =
      this.intermissionUntil > 0 ? this.intermissionUntil - this.timeMs : this.matchEndsAt - this.timeMs;
    const inter = this.intermissionUntil > 0 ? 1 : 0;
    this.pushEvent(to, (w) => {
      w.u8(Ev.MatchState).u8(inter).u32(Math.max(0, Math.round(remaining))).u16(KILL_LIMIT);
    });
  }

  private broadcastSnapshot(): void {
    const humans = [...this.players.values()].filter((p) => p.transport);
    if (humans.length === 0) return;

    const list = [...this.players.values()];
    const w = new Writer(64 + list.length * 32);
    w.u8(S2C.Snapshot);
    w.u32(this.tickNo);
    w.f64(this.wallClock());
    w.u8(list.length);
    for (const p of list) {
      let flags = 0;
      if (!p.alive) flags |= PFlag.Dead;
      if (p.move.crouching) flags |= PFlag.Crouching;
      if (p.move.grounded) flags |= PFlag.Grounded;
      if (p.reloadDoneAt > 0) flags |= PFlag.Reloading;
      if (p.protectedUntil > this.timeMs) flags |= PFlag.SpawnProtected;
      if (p.lastInput && (p.lastInput.buttons & Btn.Ads) !== 0) flags |= PFlag.Ads;
      if (this.timeMs < p.nextFireAt) flags |= PFlag.Firing;

      w.u8(p.id)
        .u8(flags)
        .f32(p.move.x)
        .f32(p.move.y)
        .f32(p.move.z)
        .i16(packAngle(p.yaw))
        .i16(packAngle(p.pitch))
        .u8(Math.max(0, Math.min(255, p.health)))
        .u8(p.weapon)
        .i16(packVel(p.move.vx))
        .i16(packVel(p.move.vy))
        .i16(packVel(p.move.vz));
    }

    // Per-player tail: their own input ack + ammo, so prediction can reconcile.
    const header = new Uint8Array(w.finish());
    for (const p of humans) {
      const pw = new Writer(header.byteLength + 16);
      pw.raw(header);
      pw.u32(p.lastSeq);
      pw.u8(p.ammo);
      pw.u8(WEAPONS[p.weapon].magSize);
      pw.u16(Math.max(0, Math.round(p.reloadDoneAt > 0 ? p.reloadDoneAt - this.timeMs : 0)));
      this.send(p, pw.finish());
    }
  }

  private flushEvents(): void {
    if (this.events.length === 0) return;
    const all = this.events;
    this.events = [];

    // Snapshot the recipient list first: a failed send removes the player.
    for (const p of [...this.players.values()]) {
      if (!p.transport) continue;
      const mine = all.filter((e) => e.to === 0 || e.to === p.id);
      if (mine.length === 0) continue;
      const w = new Writer(256);
      w.u8(S2C.Events);
      const countAt = w.off;
      w.u8(0);
      let n = 0;
      for (const e of mine) {
        e.write(w);
        n++;
        if (n === 255) break;
      }
      w.patchU8(countAt, n);
      this.send(p, w.finish());
    }
  }
}

function sanitiseName(raw: string): string {
  // Normalise first: Hangul typed as separate jamo composes to the same
  // syllables the player sees, so the length limit counts what they see too.
  // Slicing by code point keeps a surrogate pair from being cut in half.
  const clean = raw.normalize('NFC').replace(NAME_BAD_CHARS, '').trim();
  return [...clean].slice(0, NAME_MAX_LEN).join('');
}

function sampleHistory(p: RoomPlayer, t: number): HistorySample {
  const h = p.history;
  if (h.length === 0) {
    return { t, x: p.move.x, y: p.move.y, z: p.move.z, crouch: p.move.crouching };
  }
  if (t >= h[h.length - 1].t) return h[h.length - 1];
  if (t <= h[0].t) return h[0];
  // Linear scan backwards: history holds at most ~64 samples.
  for (let i = h.length - 1; i > 0; i--) {
    const b = h[i];
    const a = h[i - 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t || 1;
      const f = (t - a.t) / span;
      return {
        t,
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        crouch: f < 0.5 ? a.crouch : b.crouch,
      };
    }
  }
  return h[h.length - 1];
}
