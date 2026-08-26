import type { BotTierName } from '@webgame/shared';
import type { Quality } from '../game/Renderer.js';
import {
  DEFAULT_CROSSHAIR,
  clampCrosshair,
  crosshairRange,
  decodeCrosshair,
  drawCrosshair,
  encodeCrosshair,
  type CrosshairConfig,
} from './Crosshair.js';
import { LANGS, getLang, onLangChange, setLang, t, type Lang } from './i18n.js';
import {
  BIND_ORDER,
  DEFAULT_BINDS,
  conflictsWith,
  isRiskyBind,
  keyLabel,
  normaliseBinds,
  type KeyBinds,
} from './Keybinds.js';

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
  binds: KeyBinds;
  /**
   * Go fullscreen when the match grabs the mouse. Fullscreen is the only place
   * a page may capture Ctrl+W and friends, so this is what stops the browser
   * eating the tab mid-fight.
   */
  fullscreen: boolean;

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
  crosshair: CrosshairConfig;

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
  binds: { ...DEFAULT_BINDS },
  fullscreen: true,
  fov: 92,
  brightness: 1,
  viewmodelSway: 1,
  viewBob: 1,
  volume: 0.55,
  muted: false,
  crosshair: { ...DEFAULT_CROSSHAIR },
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
  | { kind: 'toggle'; key: BoolKey; label: string; help?: string }
  | { kind: 'language' }
  | { kind: 'keybinds' }
  | { kind: 'crosshair' };

interface Group {
  /** Translation key for the heading. */
  title: string;
  /** Options that only take effect when a match starts. */
  matchStartOnly?: boolean;
  controls: Control[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export const SETTINGS_GROUPS: Group[] = [
  {
    title: 'set.group.language',
    controls: [{ kind: 'language' }],
  },
  {
    title: 'set.group.mouse',
    controls: [
      { kind: 'slider', key: 'sensitivity', label: 'set.sensitivity', min: 0.1, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
      { kind: 'slider', key: 'adsSensitivity', label: 'set.adsSensitivity', min: 0.2, max: 1.5, step: 0.05, fmt: (v) => `${v.toFixed(2)}x` },
      { kind: 'slider', key: 'mouseSmoothing', label: 'set.mouseSmoothing', min: 0, max: 0.8, step: 0.05, fmt: (v) => (v === 0 ? t('opt.off') : v.toFixed(2)) },
      { kind: 'toggle', key: 'invertY', label: 'set.invertY' },
    ],
  },
  {
    title: 'set.group.keys',
    controls: [
      { kind: 'toggle', key: 'fullscreen', label: 'set.fullscreen', help: 'set.fullscreenHelp' },
      { kind: 'keybinds' },
    ],
  },
  {
    title: 'set.group.crosshair',
    controls: [{ kind: 'crosshair' }],
  },
  {
    title: 'set.group.view',
    controls: [
      { kind: 'slider', key: 'fov', label: 'set.fov', min: 70, max: 110, step: 1, fmt: (v) => `${Math.round(v)}°` },
      { kind: 'slider', key: 'brightness', label: 'set.brightness', min: 0.6, max: 1.6, step: 0.05, fmt: pct },
      { kind: 'slider', key: 'viewmodelSway', label: 'set.viewmodelSway', min: 0, max: 1.5, step: 0.05, fmt: (v) => (v === 0 ? t('opt.off') : pct(v)) },
      { kind: 'slider', key: 'viewBob', label: 'set.viewBob', min: 0, max: 1.5, step: 0.05, fmt: (v) => (v === 0 ? t('opt.off') : pct(v)) },
    ],
  },
  {
    title: 'set.group.audio',
    controls: [
      { kind: 'slider', key: 'volume', label: 'set.volume', min: 0, max: 1, step: 0.05, fmt: pct },
      { kind: 'toggle', key: 'muted', label: 'set.muted' },
    ],
  },
  {
    title: 'set.group.match',
    matchStartOnly: true,
    controls: [
      {
        kind: 'choice',
        key: 'botFill',
        label: 'set.botFill',
        options: [
          { value: '0', label: 'opt.off' },
          { value: '3', label: '3' },
          { value: '5', label: '5' },
          { value: '8', label: '8' },
        ],
      },
      {
        kind: 'choice',
        key: 'botSkill',
        label: 'set.botSkill',
        options: [
          { value: '0.1', label: 'opt.rookie' },
          { value: '0.3', label: 'opt.regular' },
          { value: '0.55', label: 'opt.veteran' },
          { value: '0.8', label: 'opt.elite' },
        ],
      },
      {
        kind: 'choice',
        key: 'defaultWeapon',
        label: 'set.defaultWeapon',
        options: [
          { value: '0', label: 'opt.rifle' },
          { value: '1', label: 'opt.smg' },
          { value: '2', label: 'opt.shotgun' },
          { value: '3', label: 'opt.sniper' },
        ],
      },
    ],
  },
  {
    title: 'set.group.graphics',
    controls: [
      {
        kind: 'choice',
        key: 'quality',
        label: 'set.quality',
        options: [
          { value: 'low', label: 'opt.low' },
          { value: 'medium', label: 'opt.medium' },
          { value: 'high', label: 'opt.high' },
        ],
      },
      { kind: 'slider', key: 'renderScale', label: 'set.renderScale', min: 0.5, max: 1, step: 0.05, fmt: pct },
      { kind: 'toggle', key: 'dynamicResolution', label: 'set.dynamicResolution' },
      { kind: 'toggle', key: 'screenEffects', label: 'set.screenEffects' },
    ],
  },
  {
    title: 'set.group.hud',
    controls: [
      {
        kind: 'choice',
        key: 'minimapMode',
        label: 'set.minimapMode',
        options: [
          { value: '0', label: 'opt.off' },
          { value: '1', label: 'opt.small' },
          { value: '2', label: 'opt.large' },
        ],
      },
      { kind: 'toggle', key: 'showFps', label: 'set.showFps' },
    ],
  },
];

const KEY = 'webgame.settings.v4';

export function loadSettings(): GameSettings {
  const out: GameSettings = { ...DEFAULT_SETTINGS, binds: { ...DEFAULT_BINDS }, crosshair: { ...DEFAULT_CROSSHAIR } };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return out;
    const s = JSON.parse(raw) as Partial<GameSettings>;
    for (const k of Object.keys(out) as (keyof GameSettings)[]) {
      if (k === 'binds' || k === 'crosshair') continue;
      const v = s[k];
      if (v === undefined || v === null) continue;
      if (typeof out[k] === typeof v) (out as unknown as Record<string, unknown>)[k] = v;
    }
    out.binds = normaliseBinds(s.binds);
    out.crosshair = clampCrosshair((s.crosshair ?? {}) as Partial<CrosshairConfig>);
    out.name = String(out.name ?? '').slice(0, 16);
    out.quality = out.quality === 'low' || out.quality === 'medium' ? out.quality : 'high';
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
  private readonly opts: { hideMatchStartOnly?: boolean };
  private readonly stopLang: () => void;
  /** Set while a keybind row is waiting for the next keypress. */
  private capturing: { action: keyof KeyBinds; button: HTMLButtonElement } | null = null;

  constructor(
    settings: GameSettings,
    onChange: (s: GameSettings, key: keyof GameSettings) => void,
    opts: { hideMatchStartOnly?: boolean } = {},
  ) {
    this.settings = settings;
    this.onChange = onChange;
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'settings';
    this.build();
    // Language changes rebuild the whole panel; nothing here is expensive and
    // it keeps every label in one code path.
    this.stopLang = onLangChange(() => this.build());
  }

  dispose(): void {
    this.stopLang();
    this.cancelCapture();
  }

  private build(): void {
    this.cancelCapture();
    this.root.textContent = '';
    for (const group of SETTINGS_GROUPS) {
      if (this.opts.hideMatchStartOnly && group.matchStartOnly) continue;
      const section = document.createElement('div');
      section.className = 'settings-group';
      const h = document.createElement('div');
      h.className = 'settings-title';
      h.textContent = t(group.title);
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

    switch (c.kind) {
      case 'language':
        return this.buildLanguage(wrap);
      case 'keybinds':
        return this.buildKeybinds(wrap);
      case 'crosshair':
        return this.buildCrosshair(wrap);
      case 'slider':
        return this.buildSlider(wrap, c);
      case 'toggle':
        return this.buildToggle(wrap, c);
      default:
        return this.buildChoice(wrap, c);
    }
  }

  private buildSlider(wrap: HTMLElement, c: Extract<Control, { kind: 'slider' }>): HTMLElement {
    const label = document.createElement('label');
    const value = document.createElement('span');
    value.className = 'setting-value';
    label.textContent = `${t(c.label)} `;
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

  private buildToggle(wrap: HTMLElement, c: Extract<Control, { kind: 'toggle' }>): HTMLElement {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.settings[c.key];
    input.addEventListener('change', () => {
      this.settings[c.key] = input.checked;
      this.commit(c.key);
    });
    label.append(input, document.createTextNode(` ${t(c.label)}`));
    wrap.appendChild(label);
    if (c.help) {
      const help = document.createElement('div');
      help.className = 'setting-help';
      help.textContent = t(c.help);
      wrap.appendChild(help);
    }
    return wrap;
  }

  private buildChoice(wrap: HTMLElement, c: Extract<Control, { kind: 'choice' }>): HTMLElement {
    const label = document.createElement('label');
    label.textContent = t(c.label);
    const row = document.createElement('div');
    row.className = 'row';
    const key = c.key as keyof GameSettings;
    const buttons: HTMLButtonElement[] = [];
    const sync = () => {
      const current = String(this.settings[key]);
      for (const b of buttons) b.classList.toggle('on', b.dataset.v === current);
    };
    for (const opt of c.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.dataset.v = opt.value;
      // Numeric option labels ("3", "5") are not translation keys.
      b.textContent = opt.label.includes('.') ? t(opt.label) : opt.label;
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

  // ------------------------------------------------------------------ language

  private buildLanguage(wrap: HTMLElement): HTMLElement {
    const label = document.createElement('label');
    label.textContent = t('set.language');
    const row = document.createElement('div');
    row.className = 'row';
    for (const l of LANGS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.style.marginTop = '0';
      b.textContent = l.label;
      b.classList.toggle('on', getLang() === l.id);
      b.addEventListener('click', () => setLang(l.id as Lang));
      row.appendChild(b);
    }
    wrap.append(label, row);
    return wrap;
  }

  // ------------------------------------------------------------------ keybinds

  private cancelCapture(): void {
    if (!this.capturing) return;
    window.removeEventListener('keydown', this.onCaptureKey, true);
    this.capturing.button.classList.remove('capturing');
    this.capturing.button.textContent = keyLabel(this.settings.binds[this.capturing.action]);
    this.capturing = null;
  }

  private onCaptureKey = (e: KeyboardEvent): void => {
    // Swallow the key entirely: this press is a binding, not a command, and the
    // browser must not act on it either.
    e.preventDefault();
    e.stopPropagation();
    const cap = this.capturing;
    if (!cap) return;
    if (e.code === 'Escape') {
      this.cancelCapture();
      return;
    }
    const binds = this.settings.binds;
    binds[cap.action] = e.code;
    // A key can only do one thing; whatever held it falls back to unbound-ish
    // by taking this action's previous key.
    for (const other of conflictsWith(binds, cap.action)) binds[other] = '';
    this.cancelCapture();
    this.commit('binds');
    this.build();
  };

  private buildKeybinds(wrap: HTMLElement): HTMLElement {
    wrap.classList.add('keybinds');
    const list = document.createElement('div');
    list.className = 'bindlist';
    let risky = false;

    for (const action of BIND_ORDER) {
      const row = document.createElement('div');
      row.className = 'bindrow';
      const name = document.createElement('span');
      name.textContent = t(`key.${action}`);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost bind';
      const code = this.settings.binds[action];
      btn.textContent = code ? keyLabel(code) : '—';
      if (code && isRiskyBind(code)) {
        btn.classList.add('risky');
        risky = true;
      }
      btn.addEventListener('click', () => {
        this.cancelCapture();
        this.capturing = { action, button: btn };
        btn.classList.add('capturing');
        btn.textContent = t('key.press');
        window.addEventListener('keydown', this.onCaptureKey, true);
      });
      row.append(name, btn);
      list.appendChild(row);
    }
    wrap.appendChild(list);

    if (risky) {
      const warn = document.createElement('div');
      warn.className = 'setting-help warn';
      warn.textContent = t('key.ctrlWarning');
      wrap.appendChild(warn);
    }

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ghost';
    reset.textContent = t('key.reset');
    reset.addEventListener('click', () => {
      this.settings.binds = { ...DEFAULT_BINDS };
      this.commit('binds');
      this.build();
    });
    wrap.appendChild(reset);
    return wrap;
  }

  // ----------------------------------------------------------------- crosshair

  private buildCrosshair(wrap: HTMLElement): HTMLElement {
    wrap.classList.add('xh-editor');
    const cfg = this.settings.crosshair;

    // Preview sits at the top and animates through rest → moving → firing so
    // the error settings can actually be judged.
    const preview = document.createElement('canvas');
    preview.className = 'xh-preview';
    preview.width = 132;
    preview.height = 132;
    const pctx = preview.getContext('2d')!;
    let raf = 0;
    const loop = (ts: number) => {
      const phase = (ts / 1600) % 1;
      drawCrosshair(pctx, 132, cfg, {
        moveError: phase < 0.4 ? 0 : Math.min(1, (phase - 0.4) / 0.2),
        fireError: phase < 0.7 ? 0 : Math.min(1, (phase - 0.7) / 0.15),
        ads: 0,
        hit: 0,
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    // The panel is rebuilt on every language change; stop the old loop with it.
    const stop = new MutationObserver(() => {
      if (!preview.isConnected) {
        cancelAnimationFrame(raf);
        stop.disconnect();
      }
    });
    stop.observe(this.root, { childList: true, subtree: true });
    wrap.appendChild(preview);

    const redraw = () => this.commit('crosshair');

    const swatches = document.createElement('div');
    swatches.className = 'row xh-swatches';
    const COLOURS: [string, string][] = [
      ['#e2f4ff', 'opt.white'],
      ['#6effa8', 'opt.green'],
      ['#5fe4ff', 'opt.cyan'],
      ['#ffd76e', 'opt.amber'],
      ['#ff6ec7', 'opt.pink'],
      ['#ff5a5a', 'opt.red'],
    ];
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'xh-colour';
    custom.value = cfg.colour;
    custom.title = t('xh.customColour');
    const syncSwatch = () => {
      for (const b of Array.from(swatches.querySelectorAll('button')) as HTMLButtonElement[]) {
        b.classList.toggle('on', b.dataset.v === cfg.colour);
      }
      custom.value = cfg.colour;
    };
    for (const [hex, key] of COLOURS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost xh-swatch';
      b.dataset.v = hex;
      b.title = t(key);
      b.style.setProperty('--sw', hex);
      b.addEventListener('click', () => {
        cfg.colour = hex;
        syncSwatch();
        redraw();
      });
      swatches.appendChild(b);
    }
    custom.addEventListener('input', () => {
      cfg.colour = custom.value.toLowerCase();
      syncSwatch();
      redraw();
    });
    swatches.appendChild(custom);
    syncSwatch();

    const colourLabel = document.createElement('label');
    colourLabel.textContent = t('xh.colour');
    wrap.append(colourLabel, swatches);

    const slider = (key: keyof CrosshairConfig, labelKey: string): HTMLElement => {
      const [min, max, step] = crosshairRange(key);
      const row = document.createElement('div');
      row.className = 'setting';
      const label = document.createElement('label');
      const value = document.createElement('span');
      value.className = 'setting-value';
      label.textContent = `${t(labelKey)} `;
      label.appendChild(value);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(cfg[key]);
      const show = () => {
        value.textContent = max <= 1 ? `${Math.round((cfg[key] as number) * 100)}%` : String(cfg[key]);
      };
      show();
      input.addEventListener('input', () => {
        (cfg as unknown as Record<string, unknown>)[key] = Number(input.value);
        show();
        redraw();
      });
      row.append(label, input);
      return row;
    };

    const toggle = (key: keyof CrosshairConfig, labelKey: string): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'setting';
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = cfg[key] as boolean;
      input.addEventListener('change', () => {
        (cfg as unknown as Record<string, unknown>)[key] = input.checked;
        redraw();
      });
      label.append(input, document.createTextNode(` ${t(labelKey)}`));
      row.appendChild(label);
      return row;
    };

    const sub = (titleKey: string, children: HTMLElement[]): HTMLElement => {
      const box = document.createElement('div');
      box.className = 'xh-sub';
      const h = document.createElement('div');
      h.className = 'settings-title';
      h.textContent = t(titleKey);
      box.append(h, ...children);
      return box;
    };

    wrap.append(
      sub('xh.outline', [
        toggle('outline', 'xh.outline'),
        slider('outlineOpacity', 'xh.outlineOpacity'),
        slider('outlineThickness', 'xh.outlineThickness'),
      ]),
      sub('xh.dot', [toggle('dot', 'xh.dot'), slider('dotOpacity', 'xh.dotOpacity'), slider('dotSize', 'xh.dotSize')]),
      sub('xh.innerLines', [
        toggle('innerShow', 'xh.innerLines'),
        slider('innerOpacity', 'xh.opacity'),
        slider('innerLength', 'xh.length'),
        slider('innerThickness', 'xh.thickness'),
        slider('innerOffset', 'xh.offset'),
        toggle('innerMoveError', 'xh.moveError'),
        toggle('innerFireError', 'xh.fireError'),
      ]),
      sub('xh.outerLines', [
        toggle('outerShow', 'xh.outerLines'),
        slider('outerOpacity', 'xh.opacity'),
        slider('outerLength', 'xh.length'),
        slider('outerThickness', 'xh.thickness'),
        slider('outerOffset', 'xh.offset'),
        toggle('outerMoveError', 'xh.moveError'),
        toggle('outerFireError', 'xh.fireError'),
      ]),
      slider('errorScale', 'xh.moveError'),
    );

    // Share code.
    const codeLabel = document.createElement('label');
    codeLabel.textContent = t('xh.code');
    const codeRow = document.createElement('div');
    codeRow.className = 'row';
    const codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.className = 'xh-code';
    codeInput.value = encodeCrosshair(cfg);
    codeInput.spellcheck = false;
    const status = document.createElement('div');
    status.className = 'setting-help';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ghost';
    copyBtn.style.marginTop = '0';
    copyBtn.textContent = t('xh.copy');
    copyBtn.addEventListener('click', () => {
      codeInput.value = encodeCrosshair(cfg);
      codeInput.select();
      void navigator.clipboard?.writeText(codeInput.value).catch(() => {
        /* clipboard blocked: the field is selected, Ctrl+C still works */
      });
      status.textContent = t('xh.copied');
    });

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'ghost';
    importBtn.style.marginTop = '0';
    importBtn.textContent = t('xh.import');
    importBtn.addEventListener('click', () => {
      const parsed = decodeCrosshair(codeInput.value);
      if (!parsed) {
        status.textContent = t('xh.badCode');
        return;
      }
      this.settings.crosshair = parsed;
      this.commit('crosshair');
      this.build();
    });

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'ghost';
    resetBtn.style.marginTop = '0';
    resetBtn.textContent = t('xh.reset');
    resetBtn.addEventListener('click', () => {
      this.settings.crosshair = { ...DEFAULT_CROSSHAIR };
      this.commit('crosshair');
      this.build();
    });

    codeRow.append(codeInput, copyBtn, importBtn, resetBtn);
    wrap.append(codeLabel, codeRow, status);
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
