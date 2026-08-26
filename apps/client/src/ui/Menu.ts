import type { Quality } from '../game/Renderer.js';

export interface Settings {
  name: string;
  sensitivity: number;
  quality: Quality;
  /** Bot difficulty for offline practice, 0..1. */
  botSkill: number;
}

export interface StartRequest {
  room: string;
  settings: Settings;
  offline: boolean;
  fillTo: number;
}

/** Builds that ship without a server (e.g. the standalone demo) hide online play. */
const OFFLINE_ONLY = import.meta.env.VITE_OFFLINE_ONLY === '1';

const KEY = 'webgame.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      return {
        name: (s.name ?? '').slice(0, 16),
        sensitivity: clampNum(s.sensitivity ?? 1, 0.1, 6),
        quality: s.quality === 'low' || s.quality === 'medium' || s.quality === 'high' ? s.quality : 'high',
        botSkill: clampNum(s.botSkill ?? 0.55, 0, 1),
      };
    }
  } catch {
    /* corrupt or unavailable storage: fall through to defaults */
  }
  return { name: '', sensitivity: 1, quality: 'high', botSkill: 0.55 };
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

export class Menu {
  readonly root: HTMLElement;
  private status: HTMLElement;
  private nameInput: HTMLInputElement;
  private roomInput: HTMLInputElement;
  private sensInput: HTMLInputElement;
  private qualityButtons: HTMLButtonElement[] = [];
  private skillButtons: HTMLButtonElement[] = [];
  private settings: Settings;

  constructor(parent: HTMLElement, onStart: (req: StartRequest) => Promise<void>) {
    this.settings = loadSettings();

    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.root.innerHTML = `
      <div class="menu-card">
        <h1 class="brand">REACTOR</h1>
        <p class="tagline">Multiplayer Arena FPS</p>

        <label for="pname">Callsign</label>
        <input id="pname" type="text" maxlength="16" placeholder="Enter a name" />

        <div id="ponline" ${OFFLINE_ONLY ? 'hidden' : ''}>
          <label for="proom">Match code</label>
          <div class="row">
            <input id="proom" type="text" maxlength="5" placeholder="e.g. K7QW2" autocapitalize="characters" />
            <button class="ghost" id="pcreate" style="margin-top:0">New match</button>
          </div>
        </div>

        <label>Bot difficulty</label>
        <div class="row" id="pskill">
          <button class="ghost" data-s="0.3" style="margin-top:0">Recruit</button>
          <button class="ghost" data-s="0.55" style="margin-top:0">Regular</button>
          <button class="ghost" data-s="0.8" style="margin-top:0">Veteran</button>
        </div>

        <label for="psens">Mouse sensitivity — <span id="psensval"></span></label>
        <input id="psens" type="range" min="0.1" max="4" step="0.05" style="width:100%" />

        <label>Graphics</label>
        <div class="row" id="pquality">
          <button class="ghost" data-q="low" style="margin-top:0">Low</button>
          <button class="ghost" data-q="medium" style="margin-top:0">Medium</button>
          <button class="ghost" data-q="high" style="margin-top:0">High</button>
        </div>

        <button id="pquick" ${OFFLINE_ONLY ? 'hidden' : ''}>Quick match</button>
        <button id="psolo" class="${OFFLINE_ONLY ? '' : 'ghost'}">Solo vs bots</button>
        <button id="pjoin" class="ghost" ${OFFLINE_ONLY ? 'hidden' : ''}>Join match code</button>
        <div class="status"></div>

        <div class="hint">
          <b>Quick match</b> drops you straight into the shared public arena — bots fill
          any empty slots, and real players take them over as they arrive. Share the
          address bar link to pull a friend into the same match.<br /><br />
          <kbd>WASD</kbd> move · <kbd>Space</kbd> jump · <kbd>Ctrl</kbd> crouch · <kbd>Shift</kbd> walk<br />
          <kbd>LMB</kbd> fire · <kbd>RMB</kbd> aim · <kbd>R</kbd> reload · <kbd>1-4</kbd> weapons<br />
          <kbd>Tab</kbd> scoreboard · <kbd>Y</kbd> chat · <kbd>Esc</kbd> release mouse
        </div>
      </div>
    `;
    parent.appendChild(this.root);

    this.status = this.root.querySelector('.status') as HTMLElement;
    this.nameInput = this.root.querySelector('#pname') as HTMLInputElement;
    this.roomInput = this.root.querySelector('#proom') as HTMLInputElement;
    this.sensInput = this.root.querySelector('#psens') as HTMLInputElement;
    const sensVal = this.root.querySelector('#psensval') as HTMLElement;

    this.nameInput.value = this.settings.name;
    this.sensInput.value = String(this.settings.sensitivity);
    sensVal.textContent = this.settings.sensitivity.toFixed(2);
    this.sensInput.addEventListener('input', () => {
      this.settings.sensitivity = Number(this.sensInput.value);
      sensVal.textContent = this.settings.sensitivity.toFixed(2);
      saveSettings(this.settings);
    });

    for (const btn of Array.from(this.root.querySelectorAll('#pquality button')) as HTMLButtonElement[]) {
      this.qualityButtons.push(btn);
      btn.addEventListener('click', () => {
        this.settings.quality = btn.dataset.q as Quality;
        saveSettings(this.settings);
        this.syncQuality();

    for (const btn of Array.from(this.root.querySelectorAll('#pskill button')) as HTMLButtonElement[]) {
      this.skillButtons.push(btn);
      btn.addEventListener('click', () => {
        this.settings.botSkill = Number(btn.dataset.s);
        saveSettings(this.settings);
        this.syncSkill();
      });
    }
    this.syncSkill();
      });
    }
    this.syncQuality();

    // Room code in the URL hash makes matches shareable with a single link.
    const hash = location.hash.replace('#', '').toUpperCase();
    if (/^[0-9A-Z]{5}$/.test(hash)) this.roomInput.value = hash;

    this.roomInput.addEventListener('input', () => {
      this.roomInput.value = this.roomInput.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
    });

    const create = this.root.querySelector('#pcreate') as HTMLButtonElement;
    create.addEventListener('click', async () => {
      this.setStatus('Creating match…');
      try {
        const res = await fetch('/api/room', { method: 'POST' });
        if (!res.ok) throw new Error(`server responded ${res.status}`);
        const data = (await res.json()) as { code: string };
        this.roomInput.value = data.code;
        location.hash = data.code;
        this.setStatus(`Match ${data.code} ready — share the link and hit Deploy.`);
      } catch (err) {
        this.setStatus(`Could not reach the server: ${(err as Error).message}`, true);
      }
    });

    const join = this.root.querySelector('#pjoin') as HTMLButtonElement;
    const doJoin = async () => {
      const name = this.nameInput.value.trim().slice(0, 16);
      let room = this.roomInput.value.trim().toUpperCase();
      this.settings.name = name;
      saveSettings(this.settings);

      if (!room) {
        this.setStatus('Creating match…');
        try {
          const res = await fetch('/api/room', { method: 'POST' });
          const data = (await res.json()) as { code: string };
          room = data.code;
          this.roomInput.value = room;
        } catch (err) {
          this.setStatus(`Could not reach the server: ${(err as Error).message}`, true);
          return;
        }
      }
      if (!/^[0-9A-Z]{5}$/.test(room)) {
        this.setStatus('Match codes are 5 characters.', true);
        return;
      }
      location.hash = room;
      this.setBusy(true);
      this.setStatus('Connecting…');
      try {
        await onStart({ room, settings: { ...this.settings, name: name || 'Recruit' }, offline: false, fillTo: 0 });
      } catch (err) {
        this.setStatus(`Connection failed: ${(err as Error).message}`, true);
        this.setBusy(false);
      }
    };
    join.addEventListener('click', doJoin);

    const solo = this.root.querySelector('#psolo') as HTMLButtonElement;
    const doSolo = async () => {
      const name = this.nameInput.value.trim().slice(0, 16);
      this.settings.name = name;
      saveSettings(this.settings);
      this.setBusy(true);
      this.setStatus('Building arena…');
      try {
        await onStart({
          room: 'SOLO',
          settings: { ...this.settings, name: name || 'Recruit' },
          offline: true,
          fillTo: 6,
        });
      } catch (err) {
        this.setStatus(`Could not start: ${(err as Error).message}`, true);
        this.setBusy(false);
      }
    };
    solo.addEventListener('click', doSolo);

    const quick = this.root.querySelector('#pquick') as HTMLButtonElement;
    const doQuick = async () => {
      const name = this.nameInput.value.trim().slice(0, 16);
      this.settings.name = name;
      saveSettings(this.settings);
      this.setBusy(true);
      this.setStatus('Finding a match…');
      try {
        const res = await fetch('/api/quickmatch');
        if (!res.ok) throw new Error(`server responded ${res.status}`);
        const data = (await res.json()) as { code: string; players: number };
        this.roomInput.value = data.code;
        location.hash = data.code;
        this.setStatus(
          data.players > 0 ? `Joining ${data.code} — ${data.players} already in.` : `Opening ${data.code}…`,
        );
        await onStart({
          room: data.code,
          settings: { ...this.settings, name: name || 'Recruit' },
          offline: false,
          fillTo: 0,
        });
      } catch (err) {
        this.setStatus(`Could not reach the server: ${(err as Error).message}`, true);
        this.setBusy(false);
      }
    };
    quick.addEventListener('click', doQuick);

    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // Enter runs the obvious action: join a pasted code, else quick match.
      if (OFFLINE_ONLY) void doSolo();
      else if (this.roomInput.value.trim().length === 5) void doJoin();
      else void doQuick();
    });
  }

  private syncQuality(): void {
    for (const btn of this.qualityButtons) {
      const on = btn.dataset.q === this.settings.quality;
      btn.style.borderColor = on ? 'var(--accent)' : '';
      btn.style.color = on ? 'var(--accent)' : '';
    }
  }

  private syncSkill(): void {
    for (const btn of this.skillButtons) {
      const on = Math.abs(Number(btn.dataset.s) - this.settings.botSkill) < 0.01;
      btn.style.borderColor = on ? 'var(--accent)' : '';
      btn.style.color = on ? 'var(--accent)' : '';
    }
  }

  private setBusy(busy: boolean): void {
    for (const id of ['#pjoin', '#psolo', '#pcreate', '#pquick']) {
      const el = this.root.querySelector(id) as HTMLButtonElement | null;
      if (el) el.disabled = busy;
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
  }
}
