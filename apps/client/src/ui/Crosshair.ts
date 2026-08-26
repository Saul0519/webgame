/**
 * Crosshair model, renderer and share codes.
 *
 * Lines are drawn as filled rectangles rather than strokes so every arm lands
 * on whole pixels — a 1px stroke centred on a half-pixel is what makes a
 * crosshair look soft, and a soft crosshair is a worse aiming reference.
 */

export interface CrosshairConfig {
  colour: string;
  outline: boolean;
  outlineOpacity: number;
  outlineThickness: number;

  dot: boolean;
  dotOpacity: number;
  dotSize: number;

  innerShow: boolean;
  innerOpacity: number;
  innerLength: number;
  innerThickness: number;
  innerOffset: number;
  innerMoveError: boolean;
  innerFireError: boolean;

  outerShow: boolean;
  outerOpacity: number;
  outerLength: number;
  outerThickness: number;
  outerOffset: number;
  outerMoveError: boolean;
  outerFireError: boolean;

  /** Scales how far the error offsets push the arms out. */
  errorScale: number;
  /** Fade the crosshair out while aiming down sights. */
  fadeOnAds: boolean;
}

export const DEFAULT_CROSSHAIR: CrosshairConfig = {
  colour: '#6effa8',
  outline: true,
  outlineOpacity: 0.5,
  outlineThickness: 1,

  dot: false,
  dotOpacity: 1,
  dotSize: 2,

  innerShow: true,
  innerOpacity: 1,
  innerLength: 6,
  innerThickness: 2,
  innerOffset: 3,
  innerMoveError: true,
  innerFireError: true,

  outerShow: false,
  outerOpacity: 0.35,
  outerLength: 2,
  outerThickness: 2,
  outerOffset: 10,
  outerMoveError: true,
  outerFireError: true,

  errorScale: 1,
  fadeOnAds: true,
};

/** Bounds for every numeric field, so an imported code can never break the HUD. */
const RANGES: Record<string, [min: number, max: number, step: number]> = {
  outlineOpacity: [0, 1, 0.05],
  outlineThickness: [1, 6, 1],
  dotOpacity: [0, 1, 0.05],
  dotSize: [1, 8, 1],
  innerOpacity: [0, 1, 0.05],
  innerLength: [0, 24, 1],
  innerThickness: [1, 10, 1],
  innerOffset: [0, 24, 1],
  outerOpacity: [0, 1, 0.05],
  outerLength: [0, 24, 1],
  outerThickness: [1, 10, 1],
  outerOffset: [0, 40, 1],
  errorScale: [0, 3, 0.1],
};

export function crosshairRange(key: keyof CrosshairConfig): [number, number, number] {
  return RANGES[key as string] ?? [0, 1, 0.05];
}

export function clampCrosshair(c: Partial<CrosshairConfig>): CrosshairConfig {
  const out: CrosshairConfig = { ...DEFAULT_CROSSHAIR };
  for (const k of Object.keys(out) as (keyof CrosshairConfig)[]) {
    const v = c[k];
    if (v === undefined || v === null) continue;
    if (typeof out[k] === 'boolean') {
      if (typeof v === 'boolean') (out as unknown as Record<string, unknown>)[k] = v;
    } else if (typeof out[k] === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const [lo, hi] = crosshairRange(k);
      (out as unknown as Record<string, unknown>)[k] = Math.max(lo, Math.min(hi, v));
    } else if (k === 'colour' && typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) {
      out.colour = v.toLowerCase();
    }
  }
  return out;
}

// ------------------------------------------------------------------ share code

/** Field order for the share code. Appending is safe; reordering is not. */
const BOOLS: (keyof CrosshairConfig)[] = [
  'outline',
  'dot',
  'innerShow',
  'innerMoveError',
  'innerFireError',
  'outerShow',
  'outerMoveError',
  'outerFireError',
  'fadeOnAds',
];
const NUMS: (keyof CrosshairConfig)[] = [
  'outlineOpacity',
  'outlineThickness',
  'dotOpacity',
  'dotSize',
  'innerOpacity',
  'innerLength',
  'innerThickness',
  'innerOffset',
  'outerOpacity',
  'outerLength',
  'outerThickness',
  'outerOffset',
  'errorScale',
];

/**
 * A short, typeable code. Numbers are stored in hundredths as integers so the
 * string stays free of decimal points and locale formatting.
 */
export function encodeCrosshair(c: CrosshairConfig): string {
  let flags = 0;
  BOOLS.forEach((k, i) => {
    if (c[k] as boolean) flags |= 1 << i;
  });
  const nums = NUMS.map((k) => Math.round((c[k] as number) * 100));
  return ['RX1', c.colour.slice(1), flags.toString(36), ...nums.map((n) => n.toString(36))].join('-');
}

export function decodeCrosshair(code: string): CrosshairConfig | null {
  const parts = code.trim().split('-');
  if (parts.length < 3 + NUMS.length || parts[0].toUpperCase() !== 'RX1') return null;
  if (!/^[0-9a-fA-F]{6}$/.test(parts[1])) return null;
  const flags = parseInt(parts[2], 36);
  if (!Number.isFinite(flags)) return null;
  const partial: Partial<CrosshairConfig> = { colour: `#${parts[1].toLowerCase()}` };
  BOOLS.forEach((k, i) => {
    (partial as Record<string, unknown>)[k] = (flags & (1 << i)) !== 0;
  });
  for (let i = 0; i < NUMS.length; i++) {
    const v = parseInt(parts[3 + i], 36);
    if (!Number.isFinite(v)) return null;
    (partial as Record<string, unknown>)[NUMS[i]] = v / 100;
  }
  return clampCrosshair(partial);
}

// ---------------------------------------------------------------------- draw

export interface CrosshairState {
  /** 0..1, how far the movement penalty has opened the crosshair. */
  moveError: number;
  /** 0..1, recoil/spray contribution. */
  fireError: number;
  /** 0..1 aim-down-sights blend. */
  ads: number;
  /** 0..1 hit-confirm flash. */
  hit: number;
}

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [226, 244, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** How many pixels a full error term pushes the arms out by. */
const ERROR_PX = 14;

export function drawCrosshair(
  c: CanvasRenderingContext2D,
  size: number,
  cfg: CrosshairConfig,
  st: CrosshairState,
): void {
  c.clearRect(0, 0, size, size);
  const fade = cfg.fadeOnAds ? 1 - st.ads * 0.88 : 1;
  if (fade <= 0.02) return;

  const cx = Math.round(size / 2);
  const cy = Math.round(size / 2);
  const [r, g, b] = st.hit > 0 ? [255, 108, 108] : rgb(cfg.colour);
  const fill = (a: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a * fade))})`;
  const outline = (a: number) => `rgba(0,0,0,${Math.max(0, Math.min(1, a * fade))})`;

  // One arm: a rectangle `gap` pixels from the centre, `len` long.
  const arm = (
    dx: number,
    dy: number,
    gap: number,
    len: number,
    thick: number,
    colour: string,
    grow: number,
  ): void => {
    if (len <= 0) return;
    const half = thick / 2 + grow;
    const g0 = Math.max(0, gap - grow);
    // Horizontal arms are wide and short; vertical arms are the transpose.
    const w = dx !== 0 ? len + grow * 2 : half * 2;
    const h = dy !== 0 ? len + grow * 2 : half * 2;
    const x = dx !== 0 ? cx + (dx > 0 ? g0 : -g0 - w) : cx - w / 2;
    const y = dy !== 0 ? cy + (dy > 0 ? g0 : -g0 - h) : cy - h / 2;
    c.fillStyle = colour;
    c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };

  const err = (move: boolean, fire: boolean): number => {
    let e = 0;
    if (move) e += st.moveError;
    if (fire) e += st.fireError;
    return e * cfg.errorScale * ERROR_PX;
  };

  const layers: { show: boolean; gap: number; len: number; thick: number; op: number }[] = [
    {
      show: cfg.innerShow,
      gap: cfg.innerOffset + err(cfg.innerMoveError, cfg.innerFireError),
      len: cfg.innerLength,
      thick: cfg.innerThickness,
      op: cfg.innerOpacity,
    },
    {
      show: cfg.outerShow,
      gap: cfg.outerOffset + err(cfg.outerMoveError, cfg.outerFireError),
      len: cfg.outerLength,
      thick: cfg.outerThickness,
      op: cfg.outerOpacity,
    },
  ];

  const dirs: [number, number][] = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];

  // Outlines for everything first, so a neighbouring arm's outline never lands
  // on top of an already-drawn arm.
  if (cfg.outline && cfg.outlineOpacity > 0) {
    const t = cfg.outlineThickness;
    for (const l of layers) {
      if (!l.show) continue;
      for (const [dx, dy] of dirs) arm(dx, dy, l.gap, l.len, l.thick, outline(cfg.outlineOpacity), t);
    }
    if (cfg.dot) {
      const s = cfg.dotSize + t * 2;
      c.fillStyle = outline(cfg.outlineOpacity);
      c.fillRect(Math.round(cx - s / 2), Math.round(cy - s / 2), Math.round(s), Math.round(s));
    }
  }

  for (const l of layers) {
    if (!l.show || l.op <= 0) continue;
    for (const [dx, dy] of dirs) arm(dx, dy, l.gap, l.len, l.thick, fill(l.op), 0);
  }

  if (cfg.dot && cfg.dotOpacity > 0) {
    const s = cfg.dotSize;
    c.fillStyle = fill(cfg.dotOpacity);
    c.fillRect(Math.round(cx - s / 2), Math.round(cy - s / 2), Math.round(s), Math.round(s));
  }
}
