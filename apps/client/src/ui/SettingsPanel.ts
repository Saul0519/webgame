import type { BotTierName } from '@webgame/shared';
import type { Quality } from '../game/Renderer.js';

/**
 * Every player-facing option in one place. The menu and the in-game overlay
 * both render from this schema, so adding a setting is a single entry rather
 * than two pieces of UI that drift apart.
 */
export interface GameSettings {
  name: string;

  // --- input ---
  sensitivity: number;
  /** Multiplier applied while aiming down sights. */
  adsSensitivity: number;
  invertY: boolean;
  /** 0 = raw input, 1 = heavily smoothed. */
  mouseSmoothing: number;

  // --- view ---
  fov: number;
  /** Exposure multiplier; monitors and rooms vary more than any tuned default. */
  brightness: number;
  /** 0..1 scale on weapon sway and view bob. */
  viewmodelSway: number;
  viewBob: number;

  // --- audio ---
  volume: number;
  muted: boolean;

  // --- crosshair ---
  crosshairColour: string;
  crosshairDot: boolean;
  /** Grow the crosshair with weapon spread. */
  crosshairDynamic: boolean;

  // --- match ---
  /** Participants bots top a match up to. 0 disables them. */
  botFill: number;
  /** 0..1 bot difficulty, mapped onto a named tier for the server. */
  botSkill: number;
  /** WeaponId to select on spawning in. */
  defaultWeapon: number;

  // --- graphics ---
  quality: Quality;
  renderScale: number;
  dynamicResolution: boolean;
  /** Film grain, vignette and chromatic aberration as one switch. */
  screenEffects: boolean;

  // --- hud ---
  /** 0 off, 1 small, 2 large. */
  minimapMode: number;
  showFps: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  name: '',
  sensitivity: 1,
  adsSensitivity: 1,
  invertY: false,
  mouseSmoothing: 0,
  fov: 92,
  brightness: 1,
  viewmodelSway: 1,
  viewBob: 1,
  volume: 0.55,
  muted: false,
  crosshairColour: '#e2f4ff',
  crosshairDot: true,
  crosshairDynamic: true,
  botFill: 5,
  botSkill: 0.3,
  defaultWeapon: 0,
  quality: 'high',
  renderScale: 1,
  dynamicResolution: true,
  screenEffects: true,
  minimapMode: 1,
  showFps: true,
};

type NumKey = {
  [K in keyof GameSettings]: GameSettings[K] extends number ? K : never;
}[keyof GameSettings];
type BoolKey = {
  [K in keyof GameSettings]: GameSettings[K] extends boolean ? K : never;
}[keyof GameSettings];

type StrKey = {
  [K in keyof GameSettings]: GameSettings[K] extends string ? K : never;
}[keyof GameSettings];

type Control =
  | { kind: 'slider'; key: NumKey; label: string; min: number; max: number; step: number; fmt: (v: number) => string }
  | { kind: 'choice'; key: NumKey | StrKey; label: string; options: { value: string; label: string }[] }
  | { kind: 'toggle'; key: BoolKey; label: string };

interface Group {
  title: string;
  /** Options that only take effect when a match starts. */
  matchStartOnly?: boolean;
  controls: Control[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export const SETTINGS_GROUPS: Group[] = [
  {
    title: 'Mouse',
    controls: [
      { kind: 'slider', key: 'sensitivity', label: 'Sensitivity', min: 0.1, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
      { kind: 'slider', key: 'adsSensitivity', label: 'Aim-down-sights multiplier', min: 0.2, max: 1.5, step: 0.05, fmt: (v) => `${v.toFixed(2)}x` },
      { kind: 'slider', key: 'mouseSmoothing', label: 'Smoothing', min: 0, max: 0.8, step: 0.05, fmt: (v) => (v === 0 ? 'off' : v.toFixed(2)) },
      { kind: 'toggle', key: 'invertY', label: 'Invert vertical look' },
    ],
  },
  {
    title: 'View',
    controls: [
      { kind: 'slider', key: 'fov', label: 'Field of view', min: 70, max: 110, step: 1, fmt: (v) => `${Math.round(v)}°` },
      { kind: 'slider', key: 'brightness', label: 'Brightness', min: 0.6, max: 1.6, step: 0.05, fmt: pct },
      { kind: 'slider', key: 'viewmodelSway', label: 'Weapon sway', min: 0, max: 1.5, step: 0.05, fmt: (v) => (v === 0 ? 'off' : pct(v)) },
      { kind: 'slider', key: 'viewBob', label: 'View bob', min: 0, max: 1.5, step: 0.05, fmt: (v) => (v === 0 ? 'off' : pct(v)) },
    ],
  },
  {
    title: 'Audio',
    controls: [
      { kind: 'slider', key: 'volume', label: 'Volume', min: 0, max: 1, step: 0.05, fmt: pct },
      { kind: 'toggle', key: 'muted', label: 'Mute all sound' },
    ],
  },
  {
    title: 'Crosshair',
    controls: [
      {
        kind: 'choice',
        key: 'crosshairColour',
        label: 'Colour',
        options: [
          { value: '#e2f4ff', label: 'White' },
          { value: '#6effa8', label: 'Green' },
          { value: '#ffd76e', label: 'Amber' },
          { value: '#ff6ec7', label: 'Pink' },
        ],
      },
      { kind: 'toggle', key: 'crosshairDot', label: 'Centre dot' },
      { kind: 'toggle', key: 'crosshairDynamic', label: 'Grow with spread' },
    ],
  },
  {
    title: 'Match',
    matchStartOnly: true,
    controls: [
      {
        kind: 'choice',
        key: 'botFill',
        label: 'Bots',
        options: [
          { value: '0', label: 'Off' },
          { value: '3', label: '3' },
          { value: '5', label: '5' },
          { value: '8', label: '8' },
        ],
      },
      {
        kind: 'choice',
        key: 'botSkill',
        label: 'Bot difficulty',
        options: [
          { value: '0.1', label: 'Rookie' },
          { value: '0.3', label: 'Regular' },
          { value: '0.55', label: 'Veteran' },
          { value: '0.8', label: 'Elite' },
        ],
      },
      {
        kind: 'choice',
        key: 'defaultWeapon',
        label: 'Starting weapon',
        options: [
          { value: '0', label: 'Rifle' },
          { value: '1', label: 'SMG' },
          { value: '2', label: 'Shotgun' },
          { value: '3', label: 'Sniper' },
        ],
      },
    ],
  },
  {
    title: 'Graphics',
    controls: [
      {
        kind: 'choice',
        key: 'quality',
        label: 'Quality',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
      { kind: 'slider', key: 'renderScale', label: 'Resolution', min: 0.5, max: 1, step: 0.05, fmt: pct },
      { kind: 'toggle', key: 'dynamicResolution', label: 'Auto-adjust resolution for frame rate' },
      { kind: 'toggle', key: 'screenEffects', label: 'Film grain and vignette' },
    ],
  },
  {
    title: 'HUD',
    controls: [
      {
        kind: 'choice',
        key: 'minimapMode',
        label: 'Map',
        options: [
          { value: '0', label: 'Off' },
          { value: '1', label: 'Small' },
          { value: '2', label: 'Large' },
        ],
      },
      { kind: 'toggle', key: 'showFps', label: 'Performance readout' },
    ],
  },
];

const KEY = 'webgame.settings.v3';

export function loadSettings(): GameSettings {
  const out = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return out;
    const s = JSON.parse(raw) as Partial<GameSettings>;
    for (const k of Object.keys(out) as (keyof GameSettings)[]) {
      const v = s[k];
      if (v === undefined || v === null) continue;
      if (typeof out[k] === typeof v) (out as unknown as Record<string, unknown>)[k] = v;
    }
    out.name = String(out.name ?? '').slice(0, 16);
    out.quality = out.quality === 'low' || out.quality === 'medium' ? out.quality : 'high';
    if (!/^#[0-9a-fA-F]{6}$/.test(out.crosshairColour)) out.crosshairColour = DEFAULT_SETTINGS.crosshairColour;
    // Clamp everything a slider owns so a hand-edited store cannot break the game.
    for (const g of SETTINGS_GROUPS) {
      for (const c of g.controls) {
        if (c.kind !== 'slider') continue;
        const cur = out[c.key];
        out[c.key] = Math.max(c.min, Math.min(c.max, Number.isFinite(cur) ? cur : DEFAULT_SETTINGS[c.key]));
      }
    }
  } catch {
    /* corrupt or unavailable storage: defaults are fine */
  }
  return out;
}

export function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: settings just don't persist */
  }
}

/**
 * Renders the schema into a container. `onChange` fires for every edit with the
 * key that changed so callers can live-apply the ones that support it.
 */
export class SettingsPanel {
  readonly root: HTMLElement;
  private readonly settings: GameSettings;
  private readonly onChange: (s: GameSettings, key: keyof GameSettings) => void;

  constructor(
    settings: GameSettings,
    onChange: (s: GameSettings, key: keyof GameSettings) => void,
    opts: { hideMatchStartOnly?: boolean } = {},
  ) {
    this.settings = settings;
    this.onChange = onChange;
    this.root = document.createElement('div');
    this.root.className = 'settings';

    for (const group of SETTINGS_GROUPS) {
      if (opts.hideMatchStartOnly && group.matchStartOnly) continue;
      const section = document.createElement('div');
      section.className = 'settings-group';
      const h = document.createElement('div');
      h.className = 'settings-title';
      h.textContent = group.title;
      section.appendChild(h);
      for (const control of group.controls) section.appendChild(this.buildControl(control));
      this.root.appendChild(section);
    }
  }

  private commit(key: keyof GameSettings): void {
    saveSettings(this.settings);
    this.onChange(this.settings, key);
  }

  private buildControl(c: Control): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'setting';

    if (c.kind === 'slider') {
      const label = document.createElement('label');
      const value = document.createElement('span');
      value.className = 'setting-value';
      label.textContent = `${c.label} `;
      label.appendChild(value);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(c.min);
      input.max = String(c.max);
      input.step = String(c.step);
      input.value = String(this.settings[c.key]);
      value.textContent = c.fmt(this.settings[c.key]);
      input.addEventListener('input', () => {
        this.settings[c.key] = Number(input.value);
        value.textContent = c.fmt(this.settings[c.key]);
        this.commit(c.key);
      });
      wrap.append(label, input);
      return wrap;
    }

    if (c.kind === 'toggle') {
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = this.settings[c.key];
      input.addEventListener('change', () => {
        this.settings[c.key] = input.checked;
        this.commit(c.key);
      });
      label.append(input, document.createTextNode(` ${c.label}`));
      wrap.appendChild(label);
      return wrap;
    }

    const label = document.createElement('label');
    label.textContent = c.label;
    const row = document.createElement('div');
    row.className = 'row';
    const key = c.key as keyof GameSettings;
    const buttons: HTMLButtonElement[] = [];
    const sync = () => {
      const current = String(this.settings[key]);
      for (const b of buttons) {
        const on = b.dataset.v === current;
        b.classList.toggle('on', on);
      }
    };
    for (const opt of c.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.dataset.v = opt.value;
      b.textContent = opt.label;
      b.style.marginTop = '0';
      b.addEventListener('click', () => {
        const asString = typeof this.settings[key] === 'string';
        (this.settings as unknown as Record<string, unknown>)[key] = asString ? opt.value : Number(opt.value);
        sync();
        this.commit(key);
      });
      buttons.push(b);
      row.appendChild(b);
    }
    sync();
    wrap.append(label, row);
    return wrap;
  }
}

/** Map the 0..1 difficulty slider position onto the server's named tiers. */
export function tierName(skill: number | undefined): BotTierName {
  const v = skill ?? 0.3;
  if (v <= 0.2) return 'recruit';
  if (v <= 0.42) return 'regular';
  if (v <= 0.67) return 'veteran';
  return 'elite';
}
