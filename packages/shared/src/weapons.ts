import { MAX_GROUND_SPEED } from './constants.js';

export const enum WeaponId {
  Rifle = 0,
  SMG = 1,
  Shotgun = 2,
  Sniper = 3,
}

/** Degrees to radians, so the tables below stay readable. */
const d = (deg: number): number => (deg * Math.PI) / 180;

/**
 * One entry per shot: how far the view kicks up, and how far sideways.
 * Positive side is to the right.
 *
 * These are *patterns*, not random kick. The whole point of a tactical shooter
 * is that a spray is memorisable: pull down through the climb, then trace the
 * horizontal sweep back. Past the end of the array the last entry is held with
 * an alternating sign, so long sprays wander instead of walking off screen.
 */
export type SprayPattern = readonly (readonly [up: number, side: number])[];

const RIFLE_SPRAY: SprayPattern = [
  [d(0.0), d(0.0)],
  [d(2.5), d(0.05)],
  [d(2.3), d(-0.1)],
  [d(2.0), d(-0.32)],
  [d(1.65), d(-0.62)],
  [d(1.3), d(-0.9)],
  [d(1.0), d(-0.98)],
  [d(0.8), d(-0.8)],
  [d(0.66), d(-0.34)],
  [d(0.56), d(0.38)],
  [d(0.5), d(0.92)],
  [d(0.45), d(1.15)],
  [d(0.4), d(1.02)],
  [d(0.36), d(0.55)],
  [d(0.33), d(-0.18)],
  [d(0.3), d(-0.78)],
  [d(0.28), d(-1.05)],
  [d(0.26), d(-0.86)],
  [d(0.25), d(-0.2)],
  [d(0.24), d(0.6)],
  [d(0.23), d(1.0)],
  [d(0.22), d(0.72)],
  [d(0.21), d(0.05)],
  [d(0.2), d(-0.62)],
];

const SMG_SPRAY: SprayPattern = [
  [d(0.0), d(0.0)],
  [d(1.7), d(0.08)],
  [d(1.55), d(-0.16)],
  [d(1.35), d(-0.44)],
  [d(1.1), d(-0.7)],
  [d(0.88), d(-0.8)],
  [d(0.7), d(-0.6)],
  [d(0.58), d(-0.12)],
  [d(0.5), d(0.5)],
  [d(0.44), d(0.92)],
  [d(0.4), d(0.94)],
  [d(0.37), d(0.5)],
  [d(0.34), d(-0.16)],
  [d(0.32), d(-0.74)],
  [d(0.3), d(-0.92)],
  [d(0.29), d(-0.55)],
  [d(0.28), d(0.14)],
  [d(0.27), d(0.76)],
];

// Single-shot weapons get one big kick that fully resets between shots.
const SHOTGUN_SPRAY: SprayPattern = [[d(3.4), d(0.35)]];
const SNIPER_SPRAY: SprayPattern = [[d(5.2), d(0.2)]];

export interface WeaponDef {
  id: WeaponId;
  /** Canonical display name; also the fallback when a locale has no entry. */
  name: string;
  /** Translation key the client resolves for localised HUD text. */
  nameKey: string;
  /** Rounds per minute. */
  rpm: number;
  /** Damage at point blank, before falloff and multipliers. */
  damage: number;
  /** Pellets per shot (shotgun). */
  pellets: number;
  magSize: number;
  reloadMs: number;
  /** Effective range before damage falloff starts / ends (metres). */
  falloffStart: number;
  falloffEnd: number;
  /** Damage multiplier applied at falloffEnd and beyond. */
  falloffMin: number;

  // --- accuracy ---
  /**
   * Cone half-angle standing still, hip fire / aiming down sights.
   *
   * Zero is deliberate on the precision weapons: a planted first shot has to
   * go exactly where the crosshair is, or none of the stop-before-you-shoot
   * discipline the rest of this model asks for is worth learning.
   */
  spreadHip: number;
  spreadAds: number;
  /** Cone added at full run speed. Scales with (speed/run)^3, so walking is
   * nearly free and sprinting is not. */
  spreadMove: number;
  /** Cone added while airborne. Jumping shots are meant to be a bad idea. */
  spreadAir: number;
  /** Multiplier while crouched and stationary. */
  crouchAccuracy: number;
  /**
   * Cone added per shot once the spray is past `bloomFreeShots`, and its
   * ceiling. The opening burst stays perfectly deterministic so the pattern can
   * be learned; only a long spray goes loose.
   */
  bloomPerShot: number;
  bloomMax: number;
  bloomFreeShots: number;
  /** No trigger pull for this long resets the spray index and the bloom. */
  sprayResetMs: number;

  // --- recoil ---
  spray: SprayPattern;
  /** Fraction of the accumulated kick recovered per second once you stop. */
  recoilRecovery: number;
  /** Scale on the pattern while aiming down sights. */
  adsRecoilScale: number;

  headMultiplier: number;
  legMultiplier: number;
  /** Metres/sec; 0 = pure hitscan. */
  projectileSpeed: number;
  adsFov: number;
  adsTimeMs: number;
  /** Draws a scope overlay and hides the weapon while fully aimed. */
  scoped: boolean;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  [WeaponId.Rifle]: {
    id: WeaponId.Rifle,
    name: 'VK-7 Rifle',
    nameKey: 'weapon.rifle',
    rpm: 585,
    damage: 36,
    pellets: 1,
    magSize: 25,
    reloadMs: 2450,
    falloffStart: 32,
    falloffEnd: 62,
    falloffMin: 0.72,
    spreadHip: 0,
    spreadAds: 0,
    spreadMove: 0.062,
    spreadAir: 0.085,
    crouchAccuracy: 0.72,
    bloomPerShot: 0.0011,
    bloomMax: 0.019,
    bloomFreeShots: 4,
    sprayResetMs: 420,
    spray: RIFLE_SPRAY,
    recoilRecovery: 9.5,
    adsRecoilScale: 0.86,
    headMultiplier: 3.2,
    legMultiplier: 0.85,
    projectileSpeed: 0,
    adsFov: 62,
    adsTimeMs: 170,
    scoped: false,
  },
  [WeaponId.SMG]: {
    id: WeaponId.SMG,
    name: 'MP-9 Vector',
    nameKey: 'weapon.smg',
    rpm: 800,
    damage: 23,
    pellets: 1,
    magSize: 30,
    reloadMs: 2200,
    falloffStart: 16,
    falloffEnd: 38,
    falloffMin: 0.58,
    spreadHip: 0.0032,
    spreadAds: 0,
    spreadMove: 0.034,
    spreadAir: 0.062,
    crouchAccuracy: 0.75,
    bloomPerShot: 0.0013,
    bloomMax: 0.024,
    bloomFreeShots: 3,
    sprayResetMs: 380,
    spray: SMG_SPRAY,
    recoilRecovery: 11,
    adsRecoilScale: 0.9,
    headMultiplier: 3.0,
    legMultiplier: 0.85,
    projectileSpeed: 0,
    adsFov: 68,
    adsTimeMs: 130,
    scoped: false,
  },
  [WeaponId.Shotgun]: {
    id: WeaponId.Shotgun,
    name: 'Breach-12',
    nameKey: 'weapon.shotgun',
    rpm: 84,
    damage: 11,
    pellets: 11,
    magSize: 6,
    reloadMs: 2900,
    falloffStart: 7,
    falloffEnd: 20,
    falloffMin: 0.22,
    spreadHip: 0.062,
    spreadAds: 0.042,
    spreadMove: 0.02,
    spreadAir: 0.03,
    crouchAccuracy: 0.9,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomFreeShots: 0,
    sprayResetMs: 900,
    spray: SHOTGUN_SPRAY,
    recoilRecovery: 6.5,
    adsRecoilScale: 0.8,
    headMultiplier: 1.6,
    legMultiplier: 0.9,
    projectileSpeed: 0,
    adsFov: 74,
    adsTimeMs: 200,
    scoped: false,
  },
  [WeaponId.Sniper]: {
    id: WeaponId.Sniper,
    name: 'AX-50 Marksman',
    nameKey: 'weapon.sniper',
    rpm: 40,
    damage: 150,
    pellets: 1,
    magSize: 5,
    reloadMs: 3400,
    falloffStart: 200,
    falloffEnd: 300,
    falloffMin: 1,
    // Unscoped it is a club; scoped and still it is exact.
    spreadHip: 0.075,
    spreadAds: 0,
    spreadMove: 0.06,
    spreadAir: 0.08,
    crouchAccuracy: 1,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomFreeShots: 0,
    sprayResetMs: 1400,
    spray: SNIPER_SPRAY,
    recoilRecovery: 5,
    adsRecoilScale: 1,
    headMultiplier: 1.7,
    legMultiplier: 0.8,
    projectileSpeed: 0,
    adsFov: 19,
    adsTimeMs: 330,
    scoped: true,
  },
};

export function fireIntervalMs(w: WeaponDef): number {
  return 60000 / w.rpm;
}

export function damageAtRange(w: WeaponDef, dist: number): number {
  if (dist <= w.falloffStart) return w.damage;
  if (dist >= w.falloffEnd) return w.damage * w.falloffMin;
  const t = (dist - w.falloffStart) / (w.falloffEnd - w.falloffStart);
  return w.damage * (1 + t * (w.falloffMin - 1));
}

/** Everything the accuracy model reads. Both sides can derive all of it. */
export interface FireContext {
  /** Horizontal speed, m/s. */
  speed: number;
  grounded: boolean;
  crouching: boolean;
  ads: boolean;
  /** 0 for the first shot of a spray. */
  sprayIndex: number;
}

/**
 * Cone half-angle for a shot. Standing still is dead accurate, walking barely
 * costs anything, running is a coin toss and jumping is worse — which is what
 * makes stopping before you shoot the actual skill.
 *
 * Deterministic: the client predicts tracers with it, the server resolves hits
 * with it, and both must agree.
 */
export function fireSpread(w: WeaponDef, c: FireContext): number {
  let s = c.ads ? w.spreadAds : w.spreadHip;
  const t = Math.min(1, Math.max(0, c.speed) / MAX_GROUND_SPEED);
  s += w.spreadMove * t * t * t;
  if (!c.grounded) s += w.spreadAir;
  else if (c.crouching) s *= w.crouchAccuracy;
  if (w.bloomMax > 0) {
    const beyond = Math.max(0, c.sprayIndex - w.bloomFreeShots);
    s += Math.min(w.bloomMax, beyond * w.bloomPerShot);
  }
  return s;
}

/** Recoil for one shot of a spray, in radians. */
export function sprayShot(w: WeaponDef, index: number): { up: number; side: number } {
  const p = w.spray;
  if (p.length === 0) return { up: 0, side: 0 };
  if (index < p.length) return { up: p[index][0], side: p[index][1] };
  const tail = p[p.length - 1];
  return { up: tail[0], side: (index & 1) === 0 ? tail[1] : -tail[1] };
}
