import { WEAPONS, type WeaponId } from '@webgame/shared';

export interface ScoreRow {
  id: number;
  name: string;
  kills: number;
  deaths: number;
  score: number;
  ping: number;
}

interface DamageArrow {
  el: HTMLElement;
  angle: number;
  life: number;
}

const CROSSHAIR_SIZE = 96;

export class Hud {
  readonly root: HTMLElement;
  private crosshair: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hitmarker: HTMLCanvasElement;
  private hitCtx: CanvasRenderingContext2D;
  private hitT = 0;
  private hitHead = false;

  private hpValue: HTMLElement;
  private hpFill: HTMLElement;
  private ammoValue: HTMLElement;
  private ammoMag: HTMLElement;
  private weaponName: HTMLElement;
  private killfeed: HTMLElement;
  private matchbar: HTMLElement;
  private netstat: HTMLElement;
  private vignette: HTMLElement;
  private deadscreen: HTMLElement;
  private deadSub: HTMLElement;
  private scoreboard: HTMLElement;
  private scoreBody: HTMLElement;
  private scoreSub: HTMLElement;
  private chatlog: HTMLElement;
  private chatInput: HTMLInputElement;
  private toast: HTMLElement;
  private pointerHint: HTMLElement;

  private arrows: DamageArrow[] = [];
  private hurtT = 0;
  private toastT = 0;
  private names = new Map<number, string>();
  private crosshairColour = '#e2f4ff';
  private crosshairDot = true;
  private crosshairDynamic = true;
  private netStatVisible = true;
  private selfId = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud hidden';
    this.root.innerHTML = `
      <canvas id="crosshair" width="${CROSSHAIR_SIZE}" height="${CROSSHAIR_SIZE}"></canvas>
      <canvas class="hitmarker" width="64" height="64"></canvas>
      <div class="damage-vignette"></div>
      <div class="netstat"></div>
      <div class="matchbar"></div>
      <div class="killfeed"></div>
      <div class="vitals">
        <div>
          <div class="stat-label">Health</div>
          <div class="stat-value hp">100</div>
          <div class="hp-bar"><div class="hp-fill"></div></div>
        </div>
      </div>
      <div class="ammo">
        <div class="stat-label">Ammo</div>
        <div><span class="stat-value cur">30</span><span class="mag"> / 30</span></div>
        <div class="weapon-name">VK-7 Rifle</div>
      </div>
      <div class="chatlog"></div>
      <input class="chatinput hidden" type="text" maxlength="120" placeholder="Say something and press Enter" />
      <div class="toast"></div>
      <div class="pointerhint hidden">Click to lock the mouse</div>
      <div class="deadscreen hidden">
        <div>
          <div class="dead-title">Eliminated</div>
          <div class="dead-sub"></div>
        </div>
      </div>
      <div class="scoreboard hidden">
        <h3>Scoreboard</h3>
        <div class="sub"></div>
        <table>
          <thead><tr><th>Player</th><th class="num">K</th><th class="num">D</th><th class="num">Score</th><th class="num">Lag</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    `;
    parent.appendChild(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.crosshair = q<HTMLCanvasElement>('#crosshair');
    this.ctx = this.crosshair.getContext('2d')!;
    this.hitmarker = q<HTMLCanvasElement>('.hitmarker');
    this.hitCtx = this.hitmarker.getContext('2d')!;
    this.hpValue = q('.stat-value.hp');
    this.hpFill = q('.hp-fill');
    this.ammoValue = q('.stat-value.cur');
    this.ammoMag = q('.mag');
    this.weaponName = q('.weapon-name');
    this.killfeed = q('.killfeed');
    this.matchbar = q('.matchbar');
    this.netstat = q('.netstat');
    this.vignette = q('.damage-vignette');
    this.deadscreen = q('.deadscreen');
    this.deadSub = q('.dead-sub');
    this.scoreboard = q('.scoreboard');
    this.scoreBody = q('tbody');
    this.scoreSub = q('.scoreboard .sub');
    this.chatlog = q('.chatlog');
    this.chatInput = q<HTMLInputElement>('.chatinput');
    this.toast = q('.toast');
    this.pointerHint = q('.pointerhint');
  }

  setCrosshairStyle(colour: string, dot: boolean, dynamic: boolean): void {
    this.crosshairColour = colour;
    this.crosshairDot = dot;
    this.crosshairDynamic = dynamic;
  }

  setNetStatVisible(visible: boolean): void {
    this.netStatVisible = visible;
    this.netstat.style.display = visible ? '' : 'none';
  }

  get netStatShown(): boolean {
    return this.netStatVisible;
  }

  setSelf(id: number): void {
    this.selfId = id;
  }

  setName(id: number, name: string): void {
    this.names.set(id, name);
  }

  nameOf(id: number): string {
    return this.names.get(id) ?? `Player ${id}`;
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  setPointerHint(visible: boolean): void {
    this.pointerHint.classList.toggle('hidden', !visible);
  }

  // ------------------------------------------------------------------ vitals

  setHealth(hp: number): void {
    this.hpValue.textContent = String(Math.max(0, Math.round(hp)));
    const pct = Math.max(0, Math.min(100, hp));
    this.hpFill.style.width = `${pct}%`;
    this.hpFill.classList.toggle('low', pct <= 35);
  }

  setAmmo(ammo: number, mag: number, weapon: WeaponId, reloading: boolean): void {
    this.ammoValue.textContent = String(ammo);
    this.ammoMag.textContent = ` / ${mag}`;
    this.weaponName.textContent = reloading ? 'Reloading…' : WEAPONS[weapon].name;
    this.weaponName.classList.toggle('reloading', reloading);
  }

  setDead(dead: boolean, killerName?: string, respawnIn?: number): void {
    this.deadscreen.classList.toggle('hidden', !dead);
    if (dead) {
      const who = killerName ? `Killed by ${killerName}` : 'You died';
      const when = respawnIn !== undefined && respawnIn > 0 ? `Respawning in ${respawnIn.toFixed(1)}s` : 'Press SPACE to respawn';
      this.deadSub.innerHTML = `${who}<br/>${when}`;
    }
  }

  // -------------------------------------------------------------- crosshair

  drawCrosshair(spreadPx: number, ads: number, hitFade: number): void {
    const c = this.ctx;
    const n = CROSSHAIR_SIZE;
    c.clearRect(0, 0, n, n);
    const cx = n / 2;
    const cy = n / 2;
    const alpha = 1 - ads * 0.85;
    const rgb = hexToRgb(this.crosshairColour);
    if (alpha <= 0.02) {
      // Fully aimed: a single dot keeps the sight picture clean.
      c.fillStyle = `rgba(${rgb},0.9)`;
      c.beginPath();
      c.arc(cx, cy, 1.6, 0, Math.PI * 2);
      c.fill();
      return;
    }

    const gap = 4 + (this.crosshairDynamic ? spreadPx : 0);
    const len = 7;
    c.lineCap = 'round';
    c.strokeStyle = `rgba(0,0,0,${0.55 * alpha})`;
    c.lineWidth = 3.4;
    strokeArms(c, cx, cy, gap, len);
    c.strokeStyle = hitFade > 0 ? `rgba(255,120,120,${alpha})` : `rgba(${rgb},${0.92 * alpha})`;
    c.lineWidth = 1.6;
    strokeArms(c, cx, cy, gap, len);

    if (this.crosshairDot) {
      c.fillStyle = `rgba(${rgb},${0.9 * alpha})`;
      c.beginPath();
      c.arc(cx, cy, 1.1, 0, Math.PI * 2);
      c.fill();
    }
  }

  flashHit(headshot: boolean): void {
    this.hitT = 0.34;
    this.hitHead = headshot;
  }

  // ---------------------------------------------------------------- feedback

  takeDamage(angleRad: number): void {
    this.hurtT = 1;
    const el = document.createElement('div');
    el.className = 'dmg-arrow';
    this.root.appendChild(el);
    this.arrows.push({ el, angle: angleRad, life: 1.1 });
  }

  addKillfeed(killer: string, victim: string, weapon: WeaponId, suicide: boolean, involvesSelf: boolean): void {
    const row = document.createElement('div');
    row.className = 'kf-row';
    const k = involvesSelf ? '<span class="me">' : '<span>';
    row.innerHTML = suicide
      ? `${k}${escapeHtml(victim)}</span><span class="sep">fell out of the world</span>`
      : `${k}${escapeHtml(killer)}</span><span class="sep">${WEAPONS[weapon].name}</span><span>${escapeHtml(victim)}</span>`;
    this.killfeed.appendChild(row);
    while (this.killfeed.children.length > 5) this.killfeed.removeChild(this.killfeed.firstChild!);
    setTimeout(() => row.remove(), 6000);
  }

  showToast(text: string): void {
    this.toast.textContent = text;
    this.toastT = 2.2;
  }

  addChat(who: string, text: string): void {
    const line = document.createElement('div');
    line.className = 'line';
    line.innerHTML = `<span class="who">${escapeHtml(who)}</span> ${escapeHtml(text)}`;
    this.chatlog.appendChild(line);
    while (this.chatlog.children.length > 6) this.chatlog.removeChild(this.chatlog.firstChild!);
    setTimeout(() => line.remove(), 12000);
  }

  // ------------------------------------------------------------------- panels

  setScoreboard(rows: ScoreRow[]): void {
    for (const r of rows) this.names.set(r.id, r.name);
    const sorted = [...rows].sort((a, b) => b.score - a.score || b.kills - a.kills);
    this.scoreBody.innerHTML = sorted
      .map(
        (r) =>
          `<tr class="${r.id === this.selfId ? 'self' : ''}"><td>${escapeHtml(r.name)}</td><td class="num">${r.kills}</td><td class="num">${r.deaths}</td><td class="num">${r.score}</td><td class="num">${r.ping}</td></tr>`,
      )
      .join('');
    this.scoreSub.textContent = `${rows.length} player${rows.length === 1 ? '' : 's'} · Deathmatch`;
  }

  toggleScoreboard(visible: boolean): void {
    this.scoreboard.classList.toggle('hidden', !visible);
  }

  setMatch(remainingMs: number, killLimit: number, intermission: boolean, leader?: ScoreRow): void {
    const s = Math.max(0, Math.floor(remainingMs / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    this.matchbar.innerHTML = intermission
      ? `<span>Match over</span><span class="dim">next round ${mm}:${ss}</span>`
      : `<span>${mm}:${ss}</span><span class="dim">first to ${killLimit}</span>` +
        (leader ? `<span class="dim">leader ${escapeHtml(leader.name)} ${leader.kills}</span>` : '');
  }

  setNetStat(lines: string[]): void {
    this.netstat.innerHTML = lines.map(escapeHtml).join('<br/>');
  }

  // -------------------------------------------------------------------- chat

  openChat(onSend: (text: string) => void, onClose: () => void): void {
    this.chatInput.classList.remove('hidden');
    this.chatInput.value = '';
    this.chatInput.focus();
    const finish = (send: boolean) => {
      const text = this.chatInput.value.trim();
      this.chatInput.classList.add('hidden');
      this.chatInput.blur();
      this.chatInput.removeEventListener('keydown', onKey);
      if (send && text) onSend(text);
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    };
    this.chatInput.addEventListener('keydown', onKey);
  }

  // ------------------------------------------------------------------ update

  update(dt: number): void {
    this.hurtT = Math.max(0, this.hurtT - dt * 1.6);
    this.vignette.style.opacity = String(this.hurtT * 0.9);

    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.life -= dt;
      if (a.life <= 0) {
        a.el.remove();
        this.arrows.splice(i, 1);
        continue;
      }
      a.el.style.transform = `rotate(${a.angle}rad) translateY(-150px)`;
      a.el.style.opacity = String(Math.min(1, a.life));
    }

    this.toastT = Math.max(0, this.toastT - dt);
    this.toast.style.opacity = String(Math.min(1, this.toastT));

    if (this.hitT > 0) {
      this.hitT = Math.max(0, this.hitT - dt);
      const k = this.hitT / 0.34;
      const c = this.hitCtx;
      c.clearRect(0, 0, 64, 64);
      c.strokeStyle = this.hitHead ? `rgba(255,90,90,${k})` : `rgba(255,255,255,${k})`;
      c.lineWidth = this.hitHead ? 3 : 2.2;
      c.lineCap = 'round';
      const g = 5 + (1 - k) * 4;
      const l = 8;
      for (const [sx, sy] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ]) {
        c.beginPath();
        c.moveTo(32 + sx * g, 32 + sy * g);
        c.lineTo(32 + sx * (g + l), 32 + sy * (g + l));
        c.stroke();
      }
      this.hitmarker.style.opacity = '1';
    } else {
      this.hitmarker.style.opacity = '0';
    }
  }

  get hitFade(): number {
    return this.hitT;
  }
}

function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '226,244,255';
  const v = parseInt(m[1], 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

function strokeArms(c: CanvasRenderingContext2D, cx: number, cy: number, gap: number, len: number): void {
  c.beginPath();
  c.moveTo(cx, cy - gap);
  c.lineTo(cx, cy - gap - len);
  c.moveTo(cx, cy + gap);
  c.lineTo(cx, cy + gap + len);
  c.moveTo(cx - gap, cy);
  c.lineTo(cx - gap - len, cy);
  c.moveTo(cx + gap, cy);
  c.lineTo(cx + gap + len, cy);
  c.stroke();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
