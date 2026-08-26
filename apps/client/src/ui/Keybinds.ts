import { t } from './i18n.js';

/**
 * Rebindable actions. Values are `KeyboardEvent.code`, so the layout the player
 * types in does not matter — WASD stays WASD on AZERTY hardware.
 */
export interface KeyBinds {
  forward: string;
  back: string;
  left: string;
  right: string;
  jump: string;
  crouch: string;
  walk: string;
  reload: string;
  weapon1: string;
  weapon2: string;
  weapon3: string;
  weapon4: string;
  scoreboard: string;
  map: string;
  chat: string;
  mute: string;
  fullscreen: string;
}

/**
 * Crouch defaults to C, not Ctrl.
 *
 * Ctrl+W closes the tab and Ctrl+D bookmarks the page, and neither can be
 * cancelled by a web page outside fullscreen — so a browser shooter that binds
 * crouch to Ctrl loses the window the first time somebody crouch-walks
 * forwards. Ctrl is still available as a rebind for anyone who plays fullscreen.
 */
export const DEFAULT_BINDS: KeyBinds = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  crouch: 'KeyC',
  walk: 'ShiftLeft',
  reload: 'KeyR',
  weapon1: 'Digit1',
  weapon2: 'Digit2',
  weapon3: 'Digit3',
  weapon4: 'Digit4',
  scoreboard: 'Tab',
  map: 'KeyM',
  chat: 'KeyY',
  mute: 'KeyO',
  fullscreen: 'KeyF',
};

export const BIND_ORDER: (keyof KeyBinds)[] = [
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'crouch',
  'walk',
  'reload',
  'weapon1',
  'weapon2',
  'weapon3',
  'weapon4',
  'scoreboard',
  'map',
  'chat',
  'mute',
  'fullscreen',
];

/** Key codes a page cannot reliably keep out of the browser's own shortcuts. */
export function isRiskyBind(code: string): boolean {
  return code.startsWith('Control') || code.startsWith('Alt') || code.startsWith('Meta');
}

export function normaliseBinds(raw: unknown): KeyBinds {
  const out: KeyBinds = { ...DEFAULT_BINDS };
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const k of BIND_ORDER) {
    const v = src[k];
    if (typeof v === 'string' && v.length > 0 && v.length < 24) out[k] = v;
  }
  return out;
}

const PRETTY: Record<string, string> = {
  Space: 'Space',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
  Tab: 'Tab',
  Escape: 'Esc',
  Enter: 'Enter',
  Backspace: 'Backspace',
  CapsLock: 'Caps',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

export function keyLabel(code: string): string {
  if (PRETTY[code]) return PRETTY[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

export function bindLabel(action: keyof KeyBinds): string {
  return t(`key.${action}`);
}

/** Actions currently sharing a key with `action`, if any. */
export function conflictsWith(binds: KeyBinds, action: keyof KeyBinds): (keyof KeyBinds)[] {
  return BIND_ORDER.filter((k) => k !== action && binds[k] === binds[action]);
}
