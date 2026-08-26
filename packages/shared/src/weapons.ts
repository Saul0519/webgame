export const enum WeaponId {
  Rifle = 0,
  SMG = 1,
  Shotgun = 2,
  Sniper = 3,
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
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
  /** Cone half-angle in radians: hip / ads / per-shot bloom growth / max bloom. */
  spreadHip: number;
  spreadAds: number;
  bloomPerShot: number;
  bloomMax: number;
  bloomDecay: number; // radians per second
  /** Vertical + horizontal kick applied to the view, radians per shot. */
  recoilUp: number;
  recoilSide: number;
  recoilRecovery: number; // fraction recovered per second
  headMultiplier: number;
  legMultiplier: number;
  /** Metres/sec; 0 = pure hitscan. */
  projectileSpeed: number;
  adsFov: number;
  adsTimeMs: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  [WeaponId.Rifle]: {
    id: WeaponId.Rifle,
    name: 'VK-7 Rifle',
    rpm: 620,
    damage: 26,
    pellets: 1,
    magSize: 30,
    reloadMs: 2100,
    falloffStart: 28,
    falloffEnd: 60,
    falloffMin: 0.62,
    spreadHip: 0.028,
    spreadAds: 0.0016,
    bloomPerShot: 0.0042,
    bloomMax: 0.05,
    bloomDecay: 0.09,
    recoilUp: 0.011,
    recoilSide: 0.0042,
    recoilRecovery: 7.5,
    headMultiplier: 2.0,
    legMultiplier: 0.85,
    projectileSpeed: 0,
    adsFov: 55,
    adsTimeMs: 170,
  },
  [WeaponId.SMG]: {
    id: WeaponId.SMG,
    name: 'MP-9 Vector',
    rpm: 900,
    damage: 17,
    pellets: 1,
    magSize: 35,
    reloadMs: 1750,
    falloffStart: 14,
    falloffEnd: 34,
    falloffMin: 0.5,
    spreadHip: 0.021,
    spreadAds: 0.0055,
    bloomPerShot: 0.0038,
    bloomMax: 0.055,
    bloomDecay: 0.11,
    recoilUp: 0.0075,
    recoilSide: 0.005,
    recoilRecovery: 9,
    headMultiplier: 1.8,
    legMultiplier: 0.8,
    projectileSpeed: 0,
    adsFov: 62,
    adsTimeMs: 130,
  },
  [WeaponId.Shotgun]: {
    id: WeaponId.Shotgun,
    name: 'Breach-12',
    rpm: 78,
    damage: 12,
    pellets: 9,
    magSize: 6,
    reloadMs: 2800,
    falloffStart: 6,
    falloffEnd: 18,
    falloffMin: 0.25,
    spreadHip: 0.075,
    spreadAds: 0.05,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomDecay: 0,
    recoilUp: 0.055,
    recoilSide: 0.01,
    recoilRecovery: 6,
    headMultiplier: 1.5,
    legMultiplier: 0.9,
    projectileSpeed: 0,
    adsFov: 68,
    adsTimeMs: 200,
  },
  [WeaponId.Sniper]: {
    id: WeaponId.Sniper,
    name: 'AX-50 Marksman',
    rpm: 48,
    damage: 92,
    pellets: 1,
    magSize: 5,
    reloadMs: 3200,
    falloffStart: 120,
    falloffEnd: 200,
    falloffMin: 0.9,
    spreadHip: 0.09,
    spreadAds: 0.0,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomDecay: 0,
    recoilUp: 0.09,
    recoilSide: 0.006,
    recoilRecovery: 5,
    headMultiplier: 2.5,
    legMultiplier: 0.9,
    projectileSpeed: 0,
    adsFov: 22,
    adsTimeMs: 260,
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
