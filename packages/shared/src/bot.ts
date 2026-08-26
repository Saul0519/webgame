import { Btn } from './constants.js';
import type { CollisionWorld } from './collision.js';
import type { NavGraph } from './nav.js';
import { WEAPONS, WeaponId, fireIntervalMs } from './weapons.js';
import type { WireInput } from './protocol.js';

/** What a bot is allowed to know about another player. */
export interface BotEnemy {
  id: number;
  x: number;
  y: number;
  z: number;
  alive: boolean;
}

export interface BotSelf {
  x: number;
  y: number;
  z: number;
  eye: number;
  health: number;
  ammo: number;
  weapon: WeaponId;
  reloading: boolean;
  grounded: boolean;
  speed: number;
}

export interface BotView {
  timeMs: number;
  /** Seconds since this bot last thought; turn rates are expressed per second. */
  dtSec: number;
  world: CollisionWorld;
  nav: NavGraph;
  self: BotSelf;
  enemies: BotEnemy[];
}

export type BotTierName = 'recruit' | 'regular' | 'veteran' | 'elite';

/**
 * A difficulty tier, spelled out rather than derived from one 0..1 scalar.
 *
 * A single scalar could not express "slow AND inaccurate AND unaware", which is
 * what makes a bot beatable. The knobs that actually decide whether a fight
 * feels fair are view latency, field of view, the aim cone, how often the aim
 * error is resampled, and whether re-peeking costs the bot anything — so each
 * one is an explicit number here.
 */
export interface BotTier {
  name: BotTierName;
  /** Reaction to a target that was not visible at all, in ms. */
  reactMs: [number, number];
  /** Shorter reaction when re-acquiring someone they just lost sight of. */
  reacquireMs: [number, number];
  /** Honest radians per second of view rotation. */
  turnRate: number;
  /** Half-angle of the aim error cone at point blank, radians. */
  aimCone: number;
  /** Vertical error as a fraction of the horizontal cone. */
  aimPitchScale: number;
  /** How often the aim error is redrawn. Shorter than a burst, or bursts become all-or-nothing. */
  aimResampleMs: [number, number];
  /** Bots hold fire until pointed this close to the TRUE target direction. */
  fireGate: number;
  burst: [number, number];
  burstRestMs: [number, number];
  /** Vision cone half-angle in radians. Enemies outside it are not seen. */
  fovHalf: number;
  /** Metres. Beyond this a bot simply does not notice anyone. */
  sightRange: number;
  /** Bots aim at where you were this many ms ago, like a player watching snapshots. */
  viewLatencyMs: number;
  /** Fraction of shots deliberately thrown away. */
  shotDrop: number;
  /** Only aim down sights beyond this range; Infinity means never. */
  adsRange: number;
}

export const BOT_TIERS: Record<BotTierName, BotTier> = {
  recruit: {
    name: 'recruit',
    reactMs: [620, 820],
    reacquireMs: [400, 520],
    turnRate: 2.1,
    aimCone: 0.09,
    aimPitchScale: 0.6,
    aimResampleMs: [90, 150],
    fireGate: 0.02,
    burst: [2, 3],
    burstRestMs: [700, 950],
    fovHalf: (50 * Math.PI) / 180,
    sightRange: 28,
    viewLatencyMs: 220,
    shotDrop: 0.35,
    adsRange: Infinity,
  },
  regular: {
    name: 'regular',
    reactMs: [380, 520],
    reacquireMs: [240, 340],
    turnRate: 3.2,
    aimCone: 0.055,
    aimPitchScale: 0.6,
    aimResampleMs: [80, 140],
    fireGate: 0.016,
    burst: [3, 4],
    burstRestMs: [480, 700],
    fovHalf: (65 * Math.PI) / 180,
    sightRange: 40,
    viewLatencyMs: 150,
    shotDrop: 0.15,
    adsRange: 22,
  },
  veteran: {
    name: 'veteran',
    reactMs: [240, 340],
    reacquireMs: [150, 220],
    turnRate: 4.6,
    aimCone: 0.032,
    aimPitchScale: 0.6,
    aimResampleMs: [70, 120],
    fireGate: 0.012,
    burst: [4, 6],
    burstRestMs: [320, 480],
    fovHalf: (85 * Math.PI) / 180,
    sightRange: 60,
    viewLatencyMs: 90,
    shotDrop: 0.05,
    adsRange: 18,
  },
  elite: {
    name: 'elite',
    reactMs: [140, 220],
    reacquireMs: [90, 140],
    turnRate: 6.5,
    aimCone: 0.018,
    aimPitchScale: 0.6,
    aimResampleMs: [60, 100],
    fireGate: 0.009,
    burst: [5, 8],
    burstRestMs: [200, 320],
    fovHalf: (110 * Math.PI) / 180,
    sightRange: 90,
    viewLatencyMs: 45,
    shotDrop: 0,
    adsRange: 14,
  },
};

export function tierByName(name: string | undefined): BotTier {
  const t = BOT_TIERS[(name ?? '') as BotTierName];
  return t ?? BOT_TIERS.regular;
}

/** How stale a last-known position can get before a bot gives up on it. */
const LAST_SEEN_TIMEOUT_MS = 4000;
/** Aim error grows with distance so long shots are genuinely hard. */
const RANGE_SPREAD_REF = 25;

export interface BotBrain {
  name: string;
  tier: BotTier;
  /** Per-bot variation so a lobby is not four identical opponents. */
  coneScale: number;
  reactScale: number;
  yaw: number;
  pitch: number;
  targetId: number;
  retargetAt: number;
  reactAt: number;
  wasVisible: boolean;
  lastSeenX: number;
  lastSeenY: number;
  lastSeenZ: number;
  lastSeenAt: number;
  hasLastSeen: boolean;
  path: number[];
  pathIdx: number;
  repathAt: number;
  wanderNode: number;
  strafe: number;
  strafeUntil: number;
  burstUntil: number;
  burstRestUntil: number;
  jumpAt: number;
  stuckX: number;
  stuckZ: number;
  stuckCheckAt: number;
  stuckFor: number;
  aimErrX: number;
  aimErrY: number;
  aimErrAt: number;
}

const BOT_NAMES = [
  'VEX', 'ORCA', 'KITE', 'RUST', 'NOVA', 'HALO', 'DRIFT', 'EMBER',
  'SABLE', 'QUILL', 'ONYX', 'FLINT', 'ZEPH', 'MIRA', 'TALON', 'CINDER',
];

export function botName(i: number): string {
  const base = BOT_NAMES[i % BOT_NAMES.length];
  return i < BOT_NAMES.length ? base : `${base}-${Math.floor(i / BOT_NAMES.length) + 1}`;
}

export function createBrain(name: string, tier: BotTier, yaw: number, rand: () => number): BotBrain {
  return {
    name,
    tier,
    // Vary only the two knobs a player can feel, and only a little; varying the
    // whole tier is what made a difficulty setting stop meaning anything.
    coneScale: 1 + (rand() - 0.5) * 0.24,
    reactScale: 1 + (rand() - 0.5) * 0.24,
    yaw,
    pitch: 0,
    targetId: 0,
    retargetAt: 0,
    reactAt: 0,
    wasVisible: false,
    lastSeenX: 0,
    lastSeenY: 0,
    lastSeenZ: 0,
    lastSeenAt: -1e9,
    hasLastSeen: false,
    path: [],
    pathIdx: 0,
    repathAt: 0,
    wanderNode: -1,
    strafe: 1,
    strafeUntil: 0,
    burstUntil: 0,
    burstRestUntil: 0,
    jumpAt: 0,
    stuckX: 0,
    stuckZ: 0,
    stuckCheckAt: 0,
    stuckFor: 0,
    aimErrX: 0,
    aimErrY: 0,
    aimErrAt: 0,
  };
}

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function pick(range: [number, number], rand: () => number): number {
  return range[0] + rand() * (range[1] - range[0]);
}

/** Line of sight only — the facing test is applied by the caller. */
function hasLos(view: BotView, tx: number, ty: number, tz: number): boolean {
  const ox = view.self.x;
  const oy = view.self.y + view.self.eye;
  const oz = view.self.z;
  const dx = tx - ox;
  const dy = ty - oy;
  const dz = tz - oz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.001) return true;
  return view.world.raycast(ox, oy, oz, dx / dist, dy / dist, dz / dist, dist - 0.15) === null;
}

/** True when the enemy is in front of the bot, within range, and not behind cover. */
function canSee(b: BotBrain, view: BotView, e: BotEnemy): boolean {
  const dx = e.x - view.self.x;
  const dz = e.z - view.self.z;
  const horiz = Math.hypot(dx, dz);
  if (horiz > b.tier.sightRange) return false;
  if (horiz > 0.001) {
    // Bots used to have no facing test at all, so nobody could ever flank one.
    const fwdDot = (-Math.sin(b.yaw) * dx + -Math.cos(b.yaw) * dz) / horiz;
    if (fwdDot < Math.cos(b.tier.fovHalf)) return false;
  }
  return hasLos(view, e.x, e.y + 1.1, e.z);
}

/**
 * Produce one tick of input for a bot. Deliberately plays like a person: it
 * turns at a finite rate, only knows where you were a moment ago, cannot see
 * behind itself, loses track of you behind cover, and pays a reaction cost
 * every time you reappear.
 */
export function botThink(b: BotBrain, view: BotView, rand: () => number, seq: number): WireInput {
  const now = view.timeMs;
  const self = view.self;
  const tier = b.tier;
  const weapon = WEAPONS[self.weapon];
  let buttons = 0;

  // --- Target selection -----------------------------------------------------
  let target: BotEnemy | null = null;
  if (b.targetId !== 0) {
    target = view.enemies.find((e) => e.id === b.targetId && e.alive) ?? null;
  }
  if (now >= b.retargetAt || !target) {
    b.retargetAt = now + 350 + rand() * 400;
    let best: BotEnemy | null = null;
    let bestScore = -Infinity;
    for (const e of view.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - self.x, e.y - self.y, e.z - self.z);
      // Someone they can actually see beats someone they merely heard about.
      const score = canSee(b, view, e) ? 900 - d : -d * 4;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    target = best;
    if (best && best.id !== b.targetId) {
      b.targetId = best.id;
      b.wasVisible = false;
      b.hasLastSeen = false;
    }
  }

  const visible = target ? canSee(b, view, target) : false;

  // Reaction is charged on every visibility transition, not just when the target
  // id changes — otherwise re-peeking the same bot is free and it pre-fires.
  if (visible && !b.wasVisible) {
    const range = b.hasLastSeen && now - b.lastSeenAt < 2500 ? tier.reacquireMs : tier.reactMs;
    b.reactAt = now + pick(range, rand) * b.reactScale;
  }
  b.wasVisible = visible;

  if (target && visible) {
    b.lastSeenX = target.x;
    b.lastSeenY = target.y;
    b.lastSeenZ = target.z;
    b.lastSeenAt = now;
    b.hasLastSeen = true;
  } else if (b.hasLastSeen && now - b.lastSeenAt > LAST_SEEN_TIMEOUT_MS) {
    b.hasLastSeen = false;
    b.targetId = 0;
  }

  // --- Aim ------------------------------------------------------------------
  let aimError = Math.PI;
  const aimKnown = (target !== null && visible) || b.hasLastSeen;
  const ax = target && visible ? target.x : b.lastSeenX;
  const ay = (target && visible ? target.y : b.lastSeenY) + 1.15;
  const az = target && visible ? target.z : b.lastSeenZ;

  if (aimKnown) {
    const dx = ax - self.x;
    const dy = ay - (self.y + self.eye);
    const dz = az - self.z;
    const horiz = Math.hypot(dx, dz) || 0.001;
    const range = Math.hypot(dx, dy, dz);

    // Resampled several times per burst, so a burst walks across the target
    // instead of committing to one offset and either shredding or whiffing.
    if (now >= b.aimErrAt) {
      b.aimErrAt = now + pick(tier.aimResampleMs, rand);
      const cone = tier.aimCone * b.coneScale * (1 + Math.min(1.5, range / RANGE_SPREAD_REF));
      b.aimErrX = (rand() - 0.5) * 2 * cone;
      b.aimErrY = (rand() - 0.5) * 2 * cone * tier.aimPitchScale;
    }

    const trueYaw = Math.atan2(-dx, -dz);
    const truePitch = Math.atan2(dy, horiz);
    const desiredYaw = trueYaw + b.aimErrX;
    const desiredPitch = truePitch + b.aimErrY;

    const step = tier.turnRate * view.dtSec;
    b.yaw += Math.max(-step, Math.min(step, shortestAngle(b.yaw, desiredYaw)));
    b.pitch += Math.max(-step, Math.min(step, desiredPitch - b.pitch));

    // Gate against the TRUE direction. Gating against the offset aim point made
    // the threshold decorative: it always converged, so it never held fire.
    aimError = Math.hypot(shortestAngle(b.yaw, trueYaw), truePitch - b.pitch);
  }
  b.pitch = Math.max(-1.2, Math.min(1.2, b.pitch));

  // --- Shooting -------------------------------------------------------------
  const range = target ? Math.hypot(target.x - self.x, target.y - self.y, target.z - self.z) : Infinity;
  const wantShoot =
    target !== null &&
    visible &&
    now >= b.reactAt &&
    !self.reloading &&
    self.ammo > 0 &&
    aimError < tier.fireGate &&
    range < Math.min(weapon.falloffEnd * 1.1, tier.sightRange);

  if (wantShoot) {
    if (now >= b.burstRestUntil) {
      if (now >= b.burstUntil) {
        const shots = weapon.pellets > 1 ? 1 : Math.round(pick(tier.burst, rand));
        b.burstUntil = now + shots * fireIntervalMs(weapon);
        b.burstRestUntil = 0;
      }
      if (now < b.burstUntil) {
        // A deliberate miss rate; without it low tiers still delete you the
        // moment their cone happens to settle on your chest.
        if (rand() >= tier.shotDrop) buttons |= Btn.Fire;
      } else {
        b.burstRestUntil = now + pick(tier.burstRestMs, rand);
      }
    }
    if (range > tier.adsRange && weapon.spreadAds < weapon.spreadHip) buttons |= Btn.Ads;
  } else {
    b.burstUntil = 0;
  }

  if (!self.reloading && (self.ammo === 0 || (self.ammo < weapon.magSize * 0.3 && !visible))) {
    buttons |= Btn.Reload;
  }

  // --- Movement -------------------------------------------------------------
  let forward = 0;
  let right = 0;
  let moveYaw = b.yaw;

  if (target && visible && range < 26) {
    if (now >= b.strafeUntil) {
      b.strafeUntil = now + 600 + rand() * 900;
      b.strafe = rand() < 0.5 ? -1 : 1;
    }
    const ideal = weapon.id === WeaponId.Shotgun ? 6 : 13;
    forward = range > ideal + 3 ? 1 : range < ideal - 3 ? -1 : 0;
    right = b.strafe;
    b.path.length = 0;
    if (now >= b.jumpAt && rand() < 0.02) {
      buttons |= Btn.Jump;
      b.jumpAt = now + 900;
    }
  } else {
    // Head for where the enemy was last SEEN. Navigating to their live position
    // while they are behind a wall is wallhack pathing: disengaging never works.
    const useLastSeen = b.hasLastSeen;
    const goalX = useLastSeen ? b.lastSeenX : NaN;
    const goalY = useLastSeen ? b.lastSeenY : 0;
    const goalZ = useLastSeen ? b.lastSeenZ : NaN;

    if (now >= b.repathAt || b.path.length === 0 || b.pathIdx >= b.path.length) {
      b.repathAt = now + 700 + rand() * 500;
      const from = view.nav.nearest(self.x, self.y, self.z);
      let to: number;
      if (Number.isFinite(goalX)) {
        to = view.nav.nearest(goalX, goalY, goalZ);
      } else {
        if (b.wanderNode < 0 || rand() < 0.25) {
          b.wanderNode = Math.floor(rand() * view.nav.nodes.length);
        }
        to = b.wanderNode;
      }
      view.nav.path(from, to, b.path);
      b.pathIdx = b.path.length > 1 ? 1 : 0;
    }

    if (b.path.length > 0) {
      while (b.pathIdx < b.path.length) {
        const n = view.nav.nodes[b.path[b.pathIdx]];
        if (Math.hypot(n.x - self.x, n.z - self.z) < 1.6 && Math.abs(n.y - self.y) < 2.5) b.pathIdx++;
        else break;
      }
      if (b.pathIdx < b.path.length) {
        const n = view.nav.nodes[b.path[b.pathIdx]];
        moveYaw = Math.atan2(-(n.x - self.x), -(n.z - self.z));
        forward = 1;
        if (n.y - self.y > 0.55 && self.grounded) buttons |= Btn.Jump;
      } else {
        b.wanderNode = -1;
      }
    }
  }

  // --- Unstick --------------------------------------------------------------
  if (now >= b.stuckCheckAt) {
    b.stuckCheckAt = now + 500;
    const moved = Math.hypot(self.x - b.stuckX, self.z - b.stuckZ);
    b.stuckX = self.x;
    b.stuckZ = self.z;
    if ((forward !== 0 || right !== 0) && moved < 0.55) {
      b.stuckFor++;
      if (b.stuckFor >= 2) {
        b.repathAt = 0;
        b.wanderNode = -1;
        b.strafe = -b.strafe;
        b.stuckFor = 0;
        buttons |= Btn.Jump;
      }
    } else {
      b.stuckFor = 0;
    }
  }

  // In a fight the bot faces its target; while travelling its head turns toward
  // the path. Either way the reported yaw is the smoothed one, so movement axes
  // and the visible aim direction always agree.
  if (!(target && visible)) {
    b.yaw += shortestAngle(b.yaw, moveYaw) * Math.min(1, 9 * view.dtSec);
    b.pitch += (0 - b.pitch) * Math.min(1, 4 * view.dtSec);
  }

  return {
    seq,
    buttons,
    forward,
    right,
    yaw: b.yaw,
    pitch: b.pitch,
  };
}
