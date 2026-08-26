import { Btn, TICK_DT } from './constants.js';
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
  world: CollisionWorld;
  nav: NavGraph;
  self: BotSelf;
  enemies: BotEnemy[];
}

export interface BotBrain {
  name: string;
  /** 0 = harmless, 1 = ruthless. Drives aim speed, accuracy and reaction time. */
  skill: number;
  yaw: number;
  pitch: number;
  targetId: number;
  retargetAt: number;
  /** Time at which the bot is allowed to start shooting at the current target. */
  reactAt: number;
  lastSeenX: number;
  lastSeenY: number;
  lastSeenZ: number;
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

export function createBrain(name: string, skill: number, yaw: number): BotBrain {
  return {
    name,
    skill,
    yaw,
    pitch: 0,
    targetId: 0,
    retargetAt: 0,
    reactAt: 0,
    lastSeenX: 0,
    lastSeenY: 0,
    lastSeenZ: 0,
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

/** True if the bot's eyes can see the given point. */
function canSee(view: BotView, tx: number, ty: number, tz: number): boolean {
  const ox = view.self.x;
  const oy = view.self.y + view.self.eye;
  const oz = view.self.z;
  const dx = tx - ox;
  const dy = ty - oy;
  const dz = tz - oz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.001) return true;
  const hit = view.world.raycast(ox, oy, oz, dx / dist, dy / dist, dz / dist, dist - 0.15);
  return hit === null;
}

/**
 * Produce one tick of input for a bot. Deliberately plays like a person with a
 * mouse: it turns at a finite rate, has a reaction delay, sprays a little, and
 * fires in bursts rather than holding the trigger forever.
 */
export function botThink(b: BotBrain, view: BotView, rand: () => number, seq: number): WireInput {
  const now = view.timeMs;
  const self = view.self;
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
      const visible = canSee(view, e.x, e.y + 1.1, e.z);
      const score = (visible ? 900 : 0) - d;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best && best.id !== b.targetId) {
      b.targetId = best.id;
      // Reaction time: better bots swing on faster.
      b.reactAt = now + 260 - b.skill * 170 + rand() * 120;
      b.hasLastSeen = false;
    }
    target = best;
  }

  const visible = target ? canSee(view, target.x, target.y + 1.1, target.z) : false;
  if (target && visible) {
    b.lastSeenX = target.x;
    b.lastSeenY = target.y;
    b.lastSeenZ = target.z;
    b.hasLastSeen = true;
  }

  // --- Aim ------------------------------------------------------------------
  let desiredYaw = b.yaw;
  let desiredPitch = b.pitch;
  let aimError = Math.PI;
  const aimAt = target && visible ? target : b.hasLastSeen ? null : null;
  const ax = aimAt ? aimAt.x : b.lastSeenX;
  const ay = (aimAt ? aimAt.y : b.lastSeenY) + 1.15;
  const az = aimAt ? aimAt.z : b.lastSeenZ;

  if (aimAt || b.hasLastSeen) {
    // Slowly drifting aim error, so bots miss like people rather than jittering.
    if (now >= b.aimErrAt) {
      b.aimErrAt = now + 220 + rand() * 260;
      const spread = (1 - b.skill) * 0.075 + 0.008;
      b.aimErrX = (rand() - 0.5) * 2 * spread;
      b.aimErrY = (rand() - 0.5) * 2 * spread * 0.6;
    }
    const dx = ax - self.x;
    const dy = ay - (self.y + self.eye);
    const dz = az - self.z;
    const horiz = Math.hypot(dx, dz) || 0.001;
    desiredYaw = Math.atan2(-dx, -dz) + b.aimErrX;
    desiredPitch = Math.atan2(dy, horiz) + b.aimErrY;

    const turnRate = (3.4 + b.skill * 7.5) * TICK_DT;
    const dYaw = shortestAngle(b.yaw, desiredYaw);
    const dPitch = desiredPitch - b.pitch;
    b.yaw += Math.max(-turnRate, Math.min(turnRate, dYaw));
    b.pitch += Math.max(-turnRate, Math.min(turnRate, dPitch));
    aimError = Math.hypot(shortestAngle(b.yaw, desiredYaw), desiredPitch - b.pitch);
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
    aimError < 0.06 + (1 - b.skill) * 0.05 &&
    range < weapon.falloffEnd * 1.1;

  if (wantShoot) {
    if (now >= b.burstRestUntil) {
      if (now >= b.burstUntil) {
        const shots = weapon.pellets > 1 ? 1 : 3 + Math.floor(rand() * 4);
        b.burstUntil = now + shots * fireIntervalMs(weapon);
        b.burstRestUntil = 0;
      }
      if (now < b.burstUntil) {
        buttons |= Btn.Fire;
      } else {
        b.burstRestUntil = now + 140 + (1 - b.skill) * 320 + rand() * 160;
      }
    }
    // Aim down sights at range for the tighter cone.
    if (range > 16 && weapon.spreadAds < weapon.spreadHip) buttons |= Btn.Ads;
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
    // In a fight: keep the preferred range and strafe across the target.
    if (now >= b.strafeUntil) {
      b.strafeUntil = now + 600 + rand() * 900;
      b.strafe = rand() < 0.5 ? -1 : 1;
    }
    const ideal = weapon.id === WeaponId.Shotgun ? 6 : 13;
    forward = range > ideal + 3 ? 1 : range < ideal - 3 ? -1 : 0;
    right = b.strafe;
    b.path.length = 0;
    if (now >= b.jumpAt && rand() < 0.02 * (0.4 + b.skill)) {
      buttons |= Btn.Jump;
      b.jumpAt = now + 900;
    }
  } else {
    // Otherwise navigate: toward the target's last known spot, else patrol.
    const goalX = target ? target.x : b.hasLastSeen ? b.lastSeenX : NaN;
    const goalZ = target ? target.z : b.hasLastSeen ? b.lastSeenZ : NaN;
    const goalY = target ? target.y : b.lastSeenY;

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
      // Skip waypoints we have already reached.
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
    b.yaw += shortestAngle(b.yaw, moveYaw) * Math.min(1, 9 * TICK_DT);
    b.pitch += (0 - b.pitch) * Math.min(1, 4 * TICK_DT);
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
