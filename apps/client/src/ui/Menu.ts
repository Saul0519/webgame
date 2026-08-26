import type { Quality } from '../game/Renderer.js';

export interface Settings {
  name: string;
  sensitivity: number;
  quality: Quality;
  /** 0.5..1 render resolution scale. */
  renderScale: number;
  dynamicResolution: boolean;
  /** Bot difficulty, 0..1. */
  botSkill: number;
  /** Participants bots top a match up to. 0 disables them. */
  botFill: number;
}

export interface StartRequest {
  room: string;
  settings: Settings;
  offline: boolean;
  /** Bot fill target passed to the server (only honoured in an empty room). */
  fillTo: number;
}

export interface RoomSummary {
  code: string;
  players: number;
  bots: number;
  maxPlayers: number;
  mapName: string;
}

/** Builds that ship without a server (e.g. the standalone demo) hide online play. */
const OFFLINE_ONLY = import.meta.env.VITE_OFFLINE_ONLY === '1';
const KEY = 'webgame.settings.v2';
const ROOM_REFRESH_MS = 4000;

export function loadSettings(): Settings {
  const fallback: Settings = {
    name: '',
    sensitivity: 1,
    quality: 'high',
    renderScale: 1,
    dynamicResolution: true,
    botSkill: 0.55,
    botFill: 6,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      name: (s.name ?? '').slice(0, 16),
      sensitivity: clampNum(s.sensitivity ?? 1, 0.1, 6),
      quality: s.quality === 'low' || s.quality === 'medium' || s.quality === 'high' ? s.quality : 'high',
      renderScale: clampNum(s.renderScale ?? 1, 0.5, 1),
      dynamicResolution: s.dynamicResolution !== false,
      botSkill: clampNum(s.botSkill ?? 0.55, 0, 1),
      botFill: clampNum(s.botFill ?? 6, 0, 11),
    };
  } catch {
    return fallback;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: settings just don't persist */
  }
}

function clampNum(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class Menu {
  readonly root: HTMLElement;
  private readonly onStart: (req: StartRequest) => Promise<void>;
  private status: HTMLElement;
  private nameInput: HTMLInputElement;
  private roomInput: HTMLInputElement;
  private sensInput: HTMLInputElement;
  private scaleInput: HTMLInputElement;
  private roomList: HTMLElement;
  private settings: Settings;
  private groups = new Map<string, { buttons: HTMLButtonElement[]; value: () => string }>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(parent: HTMLElement, onStart: (req: StartRequest) => Promise<void>) {
    this.settings = loadSettings();
    this.onStart = onStart;

    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.root.innerHTML = `
      <div class="menu-card">
        <h1 class="brand">REACTOR</h1>
        <p class="tagline">Multiplayer Arena FPS</p>

        <label for="pname">Callsign</label>
        <input id="pname" type="text" maxlength="16" placeholder="Enter a name" />

        <div id="ponline" ${OFFLINE_ONLY ? 'hidden' : ''}>
          <label>Live servers <span class="dim" id="prefreshing"></span></label>
          <div class="roomlist" id="proomlist"></div>

          <button id="pquick">Quick match</button>
        </div>

        <button id="psolo" class="${OFFLINE_ONLY ? '' : 'ghost'}">Solo vs bots</button>

        <details class="opts">
          <summary>Options</summary>

          <label>Bots <span class="dim" id="pbotsval"></span></label>
          <div class="row" id="pbots">
            <button class="ghost" data-v="0">Off</button>
            <button class="ghost" data-v="2">2</button>
            <button class="ghost" data-v="4">4</button>
            <button class="ghost" data-v="6">6</button>
          </div>

          <label>Bot difficulty</label>
          <div class="row" id="pskill">
            <button class="ghost" data-v="0.3">Recruit</button>
            <button class="ghost" data-v="0.55">Regular</button>
            <button class="ghost" data-v="0.8">Veteran</button>
          </div>

          <label>Graphics</label>
          <div class="row" id="pquality">
            <button class="ghost" data-v="low">Low</button>
            <button class="ghost" data-v="medium">Medium</button>
            <button class="ghost" data-v="high">High</button>
          </div>

          <label for="pscale">Resolution — <span id="pscaleval"></span></label>
          <input id="pscale" type="range" min="0.5" max="1" step="0.05" />
          <label class="check"><input id="pdyn" type="checkbox" /> Auto-adjust resolution to hold frame rate</label>

          <label for="psens">Mouse sensitivity — <span id="psensval"></span></label>
          <input id="psens" type="range" min="0.1" max="4" step="0.05" />

          <label for="proom">Join by match code</label>
          <div class="row">
            <input id="proom" type="text" maxlength="5" placeholder="e.g. K7QW2" autocapitalize="characters" />
            <button class="ghost" id="pjoin" style="margin-top:0">Join</button>
          </div>
          <button class="ghost" id="pcreate">Create private match</button>
        </details>

        <div class="status"></div>

        <div class="hint">
          <b>Quick match</b> drops you into the busiest open arena. Share the address bar
          link to pull a friend into the same one. Bots fill empty slots and step aside
          as real players arrive — set <b>Bots: Off</b> in Options for a clean lobby.<br /><br />
          <kbd>WASD</kbd> move · <kbd>Space</kbd> jump · <kbd>Ctrl</kbd> crouch · <kbd>Shift</kbd> walk<br />
          <kbd>LMB</kbd> fire · <kbd>RMB</kbd> aim · <kbd>R</kbd> reload · <kbd>1-4</kbd> weapons<br />
          <kbd>Tab</kbd> scoreboard · <kbd>M</kbd> map · <kbd>Y</kbd> chat · <kbd>O</kbd> mute · <kbd>Esc</kbd> release mouse
        </div>
      </div>
    `;
    parent.appendChild(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.status = q('.status');
    this.nameInput = q<HTMLInputElement>('#pname');
    this.roomInput = q<HTMLInputElement>('#proom');
    this.sensInput = q<HTMLInputElement>('#psens');
    this.scaleInput = q<HTMLInputElement>('#pscale');
    this.roomList = q('#proomlist');

    this.nameInput.value = this.settings.name;
    this.bindSlider(this.sensInput, q('#psensval'), 'sensitivity', (v) => v.toFixed(2));
    this.bindSlider(this.scaleInput, q('#pscaleval'), 'renderScale', (v) => `${Math.round(v * 100)}%`);

    const dyn = q<HTMLInputElement>('#pdyn');
    dyn.checked = this.settings.dynamicResolution;
    dyn.addEventListener('change', () => {
      this.settings.dynamicResolution = dyn.checked;
      saveSettings(this.settings);
    });

    this.bindGroup('#pbots', () => String(this.settings.botFill), (v) => {
      this.settings.botFill = Number(v);
      q('#pbotsval').textContent = this.settings.botFill === 0 ? 'disabled' : `fill to ${this.settings.botFill}`;
    });
    this.bindGroup('#pskill', () => String(this.settings.botSkill), (v) => {
      this.settings.botSkill = Number(v);
    });
    this.bindGroup('#pquality', () => this.settings.quality, (v) => {
      this.settings.quality = v as Quality;
    });
    q('#pbotsval').textContent = this.settings.botFill === 0 ? 'disabled' : `fill to ${this.settings.botFill}`;

    // Room code in the URL hash makes matches shareable with a single link.
    const hash = location.hash.replace('#', '').toUpperCase();
    if (/^[0-9A-Z]{5}$/.test(hash)) this.roomInput.value = hash;
    this.roomInput.addEventListener('input', () => {
      this.roomInput.value = this.roomInput.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
    });

    q<HTMLButtonElement>('#pquick').addEventListener('click', () => void this.quickMatch());
    q<HTMLButtonElement>('#psolo').addEventListener('click', () => void this.startSolo());
    q<HTMLButtonElement>('#pjoin').addEventListener('click', () => void this.joinCode());
    q<HTMLButtonElement>('#pcreate').addEventListener('click', () => void this.createPrivate());

    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (OFFLINE_ONLY) void this.startSolo();
      else if (this.roomInput.value.trim().length === 5) void this.joinCode();
      else void this.quickMatch();
    });

    if (!OFFLINE_ONLY) {
      void this.refreshRooms();
      this.refreshTimer = setInterval(() => void this.refreshRooms(), ROOM_REFRESH_MS);
    }
  }

  // ------------------------------------------------------------------ widgets

  private bindSlider(
    input: HTMLInputElement,
    label: HTMLElement,
    key: 'sensitivity' | 'renderScale',
    fmt: (v: number) => string,
  ): void {
    input.value = String(this.settings[key]);
    label.textContent = fmt(this.settings[key]);
    input.addEventListener('input', () => {
      this.settings[key] = Number(input.value);
      label.textContent = fmt(this.settings[key]);
      saveSettings(this.settings);
    });
  }

  private bindGroup(sel: string, value: () => string, apply: (v: string) => void): void {
    const buttons = Array.from(this.root.querySelectorAll(`${sel} button`)) as HTMLButtonElement[];
    const sync = () => {
      const current = value();
      for (const b of buttons) {
        const on = b.dataset.v === current;
        b.style.borderColor = on ? 'var(--accent)' : '';
        b.style.color = on ? 'var(--accent)' : '';
      }
    };
    for (const b of buttons) {
      b.addEventListener('click', () => {
        apply(b.dataset.v!);
        saveSettings(this.settings);
        sync();
      });
    }
    this.groups.set(sel, { buttons, value });
    sync();
  }

  // -------------------------------------------------------------- room browser

  private async refreshRooms(): Promise<void> {
    if (this.busy || this.root.classList.contains('hidden')) return;
    try {
      const res = await fetch('/api/rooms');
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { rooms: RoomSummary[] };
      this.renderRooms(data.rooms);
    } catch {
      this.roomList.innerHTML = '<div class="room-empty">Server unreachable — Solo vs bots still works.</div>';
    }
  }

  private renderRooms(rooms: RoomSummary[]): void {
    // Busy rooms first so there is always something worth clicking at the top.
    const sorted = [...rooms].sort((a, b) => b.players - a.players || a.code.localeCompare(b.code));
    this.roomList.innerHTML = sorted
      .map((r) => {
        const full = r.players >= r.maxPlayers;
        const live = r.players > 0;
        return `<button class="room ${live ? 'live' : ''}" data-code="${r.code}" ${full ? 'disabled' : ''}>
          <span class="room-dot"></span>
          <span class="room-code">${escapeHtml(r.code)}</span>
          <span class="room-map">${escapeHtml(r.mapName)}</span>
          <span class="room-count">${r.players}/${r.maxPlayers}${r.bots > 0 ? ` +${r.bots} bots` : ''}</span>
        </button>`;
      })
      .join('');
    for (const btn of Array.from(this.roomList.querySelectorAll('button.room')) as HTMLButtonElement[]) {
      btn.addEventListener('click', () => void this.join(btn.dataset.code!));
    }
  }

  // ------------------------------------------------------------------ actions

  private commitName(): string {
    const name = this.nameInput.value.trim().slice(0, 16);
    this.settings.name = name;
    saveSettings(this.settings);
    return name || 'Recruit';
  }

  private async join(code: string): Promise<void> {
    const name = this.commitName();
    location.hash = code;
    this.roomInput.value = code;
    this.setBusy(true);
    this.setStatus(`Connecting to ${code}…`);
    try {
      await this.onStart({
        room: code,
        settings: { ...this.settings, name },
        offline: false,
        fillTo: this.settings.botFill,
      });
    } catch (err) {
      this.setStatus(`Connection failed: ${(err as Error).message}`, true);
      this.setBusy(false);
    }
  }

  private async quickMatch(): Promise<void> {
    this.setBusy(true);
    this.setStatus('Finding a match…');
    try {
      const res = await fetch('/api/quickmatch');
      if (!res.ok) throw new Error(`server responded ${res.status}`);
      const data = (await res.json()) as { code: string };
      this.setBusy(false);
      await this.join(data.code);
    } catch (err) {
      this.setStatus(`Could not reach the server: ${(err as Error).message}`, true);
      this.setBusy(false);
    }
  }

  private async joinCode(): Promise<void> {
    const code = this.roomInput.value.trim().toUpperCase();
    if (!/^[0-9A-Z]{5}$/.test(code)) {
      this.setStatus('Match codes are 5 characters.', true);
      return;
    }
    await this.join(code);
  }

  private async createPrivate(): Promise<void> {
    this.setBusy(true);
    this.setStatus('Creating match…');
    try {
      const res = await fetch('/api/room', { method: 'POST' });
      if (!res.ok) throw new Error(`server responded ${res.status}`);
      const data = (await res.json()) as { code: string };
      this.setBusy(false);
      await this.join(data.code);
    } catch (err) {
      this.setStatus(`Could not reach the server: ${(err as Error).message}`, true);
      this.setBusy(false);
    }
  }

  private async startSolo(): Promise<void> {
    const name = this.commitName();
    this.setBusy(true);
    this.setStatus('Building arena…');
    try {
      await this.onStart({
        room: 'SOLO',
        settings: { ...this.settings, name },
        offline: true,
        fillTo: this.settings.botFill,
      });
    } catch (err) {
      this.setStatus(`Could not start: ${(err as Error).message}`, true);
      this.setBusy(false);
    }
  }

  // -------------------------------------------------------------------- state

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const id of ['#pjoin', '#psolo', '#pcreate', '#pquick']) {
      const el = this.root.querySelector(id) as HTMLButtonElement | null;
      if (el) el.disabled = busy;
    }
    for (const el of Array.from(this.roomList.querySelectorAll('button')) as HTMLButtonElement[]) {
      el.disabled = busy;
    }
  }

  setStatus(text: string, isError = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('err', isError);
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  show(message?: string): void {
    this.root.classList.remove('hidden');
    this.setBusy(false);
    if (message) this.setStatus(message, true);
    if (!OFFLINE_ONLY) void this.refreshRooms();
  }

  dispose(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
}
