import type { Quality } from '../game/Renderer.js';

export interface Settings {
  name: string;
  sensitivity: number;
  quality: Quality;
}

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
      };
    }
  } catch {
    /* corrupt or unavailable storage: fall through to defaults */
  }
  return { name: '', sensitivity: 1, quality: 'high' };
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
  private settings: Settings;

  constructor(parent: HTMLElement, onStart: (room: string, settings: Settings) => Promise<void>) {
    this.settings = loadSettings();

    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.root.innerHTML = `
      <div class="menu-card">
        <h1 class="brand">REACTOR</h1>
        <p class="tagline">Multiplayer Arena FPS</p>

        <label for="pname">Callsign</label>
        <input id="pname" type="text" maxlength="16" placeholder="Enter a name" />

        <label for="proom">Match code</label>
        <div class="row">
          <input id="proom" type="text" maxlength="5" placeholder="e.g. K7QW2" autocapitalize="characters" />
          <button class="ghost" id="pcreate" style="margin-top:0">New match</button>
        </div>

        <label for="psens">Mouse sensitivity — <span id="psensval"></span></label>
        <input id="psens" type="range" min="0.1" max="4" step="0.05" style="width:100%" />

        <label>Graphics</label>
        <div class="row" id="pquality">
          <button class="ghost" data-q="low" style="margin-top:0">Low</button>
          <button class="ghost" data-q="medium" style="margin-top:0">Medium</button>
          <button class="ghost" data-q="high" style="margin-top:0">High</button>
        </div>

        <button id="pjoin">Deploy</button>
        <div class="status"></div>

        <div class="hint">
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
      join.disabled = true;
      this.setStatus('Connecting…');
      try {
        await onStart(room, { ...this.settings, name: name || 'Recruit' });
      } catch (err) {
        this.setStatus(`Connection failed: ${(err as Error).message}`, true);
        join.disabled = false;
      }
    };
    join.addEventListener('click', doJoin);
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void doJoin();
    });
  }

  private syncQuality(): void {
    for (const btn of this.qualityButtons) {
      const on = btn.dataset.q === this.settings.quality;
      btn.style.borderColor = on ? 'var(--accent)' : '';
      btn.style.color = on ? 'var(--accent)' : '';
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
    const join = this.root.querySelector('#pjoin') as HTMLButtonElement;
    join.disabled = false;
    if (message) this.setStatus(message, true);
  }
}
