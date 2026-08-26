import { SettingsPanel, loadSettings, saveSettings, tierName, type GameSettings } from './SettingsPanel.js';

export type { GameSettings } from './SettingsPanel.js';

export interface StartRequest {
  room: string;
  settings: GameSettings;
  offline: boolean;
  /** Bot fill target passed to the server (only honoured in an empty room). */
  fillTo: number;
  /** Difficulty tier name passed to the server (also empty-room only). */
  tier: string;
}

export interface RoomSummary {
  code: string;
  players: number;
  bots: number;
  maxPlayers: number;
  mapName: string;
  botTier?: string;
}

/** Builds that ship without a server (e.g. the standalone demo) hide online play. */
const OFFLINE_ONLY = import.meta.env.VITE_OFFLINE_ONLY === '1';
const ROOM_REFRESH_MS = 4000;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class Menu {
  readonly root: HTMLElement;
  private readonly onStart: (req: StartRequest) => Promise<void>;
  private status: HTMLElement;
  private nameInput: HTMLInputElement;
  private roomInput: HTMLInputElement;
  private roomList: HTMLElement;
  private settings: GameSettings;
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
          <label>Live servers</label>
          <div class="roomlist" id="proomlist"></div>
          <button id="pquick">Quick match</button>
        </div>

        <button id="psolo" class="${OFFLINE_ONLY ? '' : 'ghost'}">Solo vs bots</button>

        <details class="opts">
          <summary>Settings</summary>
          <div id="popts"></div>

          <label for="proom">Join by match code</label>
          <div class="row">
            <input id="proom" type="text" maxlength="5" placeholder="e.g. K7QW2" autocapitalize="characters" />
            <button class="ghost" id="pjoin" style="margin-top:0">Join</button>
          </div>
          <button class="ghost" id="pcreate">Create private match</button>
        </details>

        <div class="status"></div>

        <div class="hint">
          Pick a server above, or hit <b>Quick match</b> for the busiest one. Bots fill
          empty slots and step aside as players arrive — set <b>Bots: Off</b> in Settings
          for a clean lobby. Difficulty and bot count apply to whichever room you open
          first; joining a running match inherits its settings.<br /><br />
          <kbd>WASD</kbd> move · <kbd>Space</kbd> jump · <kbd>Ctrl</kbd> crouch · <kbd>Shift</kbd> walk<br />
          <kbd>LMB</kbd> fire · <kbd>RMB</kbd> aim · <kbd>R</kbd> reload · <kbd>1-4</kbd> weapons<br />
          <kbd>Tab</kbd> scoreboard · <kbd>M</kbd> map · <kbd>Y</kbd> chat · <kbd>Esc</kbd> settings
        </div>
      </div>
    `;
    parent.appendChild(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.status = q('.status');
    this.nameInput = q<HTMLInputElement>('#pname');
    this.roomInput = q<HTMLInputElement>('#proom');
    this.roomList = q('#proomlist');

    this.nameInput.value = this.settings.name;

    // One schema, rendered here and again in the in-game overlay.
    const panel = new SettingsPanel(this.settings, () => {
      /* saved by the panel; nothing is live until a match starts */
    });
    q('#popts').appendChild(panel.root);

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
          <span class="room-map">${escapeHtml(r.mapName)}${live && r.botTier ? ` · ${escapeHtml(r.botTier)}` : ''}</span>
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
        tier: tierName(this.settings.botSkill),
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
        tier: tierName(this.settings.botSkill),
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
