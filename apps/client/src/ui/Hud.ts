import { WEAPONS, type WeaponId } from '@webgame/shared';
import { DEFAULT_CROSSHAIR, drawCrosshair, type CrosshairConfig, type CrosshairState } from './Crosshair.js';
import { onLangChange, t } from './i18n.js';
import { keyLabel } from './Keybinds.js';

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

const CROSSHAIR_SIZE = 160;

export class Hud {
  readonly root: HTMLElement;
  private crosshair: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scope: HTMLCanvasElement;
  private scopeCtx: CanvasRenderingContext2D;
  private scopeShown = 0;
  private hitmarker: HTMLCanvasElement;
  private hitCtx: CanvasRenderingContext2D;
  private hitT = 0;
  private hitHead = false;

  private hpLabel: HTMLElement;
  private hpValue: HTMLElement;
  private hpFill: HTMLElement;
  private ammoLabel: HTMLElement;
  private ammoValue: HTMLElement;
  private ammoMag: HTMLElement;
  private weaponName: HTMLElement;
  private killfeed: HTMLElement;
  private matchbar: HTMLElement;
  private netstat: HTMLElement;
  private vignette: HTMLElement;
  private deadscreen: HTMLElement;
  private deadTitle: HTMLElement;
  private deadSub: HTMLElement;
  private scoreboard: HTMLElement;
  private scoreTitle: HTMLElement;
  private scoreHead: HTMLElement;
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
  private crosshairCfg: CrosshairConfig = { ...DEFAULT_CROSSHAIR };
  private netStatVisible = true;
  private selfId = 0;
  /** Cached so a language switch can redraw the panels that hold live data. */
  private lastRows: ScoreRow[] = [];
  private deadState: { dead: boolean; killer?: string; respawnIn?: number } = { dead: false };
  private ammoState = { ammo: 0, mag: 0, weapon: 0 as WeaponId, reloading: false };
  private respawnKey = 'Space';
  private stopLang: () => void;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud hidden';
    this.root.innerHTML = `
      <canvas class="scope"></canvas>
      <canvas id="crosshair" width="${CROSSHAIR_SIZE}" height="${CROSSHAIR_SIZE}"></canvas>
      <canvas class="hitmarker" width="64" height="64"></canvas>
      <div class="damage-vignette"></div>
      <div class="netstat"></div>
      <div class="matchbar"></div>
      <div class="killfeed"></div>
      <div class="vitals">
        <div>
          <div class="stat-label hp-label"></div>
          <div class="stat-value hp">100</div>
          <div class="hp-bar"><div class="hp-fill"></div></div>
        </div>
      </div>
      <div class="ammo">
        <div class="stat-label ammo-label"></div>
        <div><span class="stat-value cur">30</span><span class="mag"> / 30</span></div>
        <div class="weapon-name"></div>
      </div>
      <div class="chatlog"></div>
      <input class="chatinput hidden" type="text" maxlength="120" />
      <div class="toast"></div>
      <div class="pointerhint hidden"></div>
      <div class="deadscreen hidden">
        <div>
          <div class="dead-title"></div>
          <div class="dead-sub"></div>
        </div>
      </div>
      <div class="scoreboard hidden">
        <h3></h3>
        <div class="sub"></div>
        <table>
          <thead><tr></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    `;
    parent.appendChild(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.crosshair = q<HTMLCanvasElement>('#crosshair');
    this.ctx = this.crosshair.getContext('2d')!;
    this.scope = q<HTMLCanvasElement>('.scope');
    this.scopeCtx = this.scope.getContext('2d')!;
    this.hitmarker = q<HTMLCanvasElement>('.hitmarker');
    this.hitCtx = this.hitmarker.getContext('2d')!;
    this.hpLabel = q('.hp-label');
    this.hpValue = q('.stat-value.hp');
    this.hpFill = q('.hp-fill');
    this.ammoLabel = q('.ammo-label');
    this.ammoValue = q('.stat-value.cur');
    this.ammoMag = q('.mag');
    this.weaponName = q('.weapon-name');
    this.killfeed = q('.killfeed');
    this.matchbar = q('.matchbar');
    this.netstat = q('.netstat');
    this.vignette = q('.damage-vignette');
    this.deadscreen = q('.deadscreen');
    this.deadTitle = q('.dead-title');
    this.deadSub = q('.dead-sub');
    this.scoreboard = q('.scoreboard');
    this.scoreTitle = q('.scoreboard h3');
    this.scoreHead = q('.scoreboard thead tr');
    this.scoreBody = q('tbody');
    this.scoreSub = q('.scoreboard .sub');
    this.chatlog = q('.chatlog');
    this.chatInput = q<HTMLInputElement>('.chatinput');
    this.toast = q('.toast');
    this.pointerHint = q('.pointerhint');

    this.retranslate();
    this.stopLang = onLangChange(() => this.retranslate());
  }

  dispose(): void {
    this.stopLang();
  }

  /** Re-render every static label plus the panels that mix labels with data. */
  private retranslate(): void {
    this.hpLabel.textContent = t('hud.health');
    this.ammoLabel.textContent = t('hud.ammo');
    this.chatInput.placeholder = t('hud.chatPlaceholder');
    this.pointerHint.textContent = t('hud.clickToLock');
    this.deadTitle.textContent = t('hud.eliminated');
    this.scoreTitle.textContent = t('hud.scoreboard');
    this.scoreHead.innerHTML =
      `<th>${t('hud.colPlayer')}</th><th class="num">${t('hud.colKills')}</th>` +
      `<th class="num">${t('hud.colDeaths')}</th><th class="num">${t('hud.colScore')}</th>` +
      `<th class="num">${t('hud.colPing')}</th>`;
    this.setAmmo(this.ammoState.ammo, this.ammoState.mag, this.ammoState.weapon, this.ammoState.reloading);
    if (this.lastRows.length > 0) this.setScoreboard(this.lastRows);
    if (this.deadState.dead) this.setDead(true, this.deadState.killer, this.deadState.respawnIn);
  }

  setCrosshair(cfg: CrosshairConfig): void {
    this.crosshairCfg = cfg;
  }

  /** The key label shown on the death screen, so a rebind is reflected there. */
  setRespawnKey(code: string): void {
    this.respawnKey = code;
    if (this.deadState.dead) this.setDead(true, this.deadState.killer, this.deadState.respawnIn);
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
    this.ammoState = { ammo, mag, weapon, reloading };
    this.ammoValue.textContent = String(ammo);
    this.ammoMag.textContent = ` / ${mag}`;
    this.weaponName.textContent = reloading ? t('hud.reloading') : weaponName(weapon);
    this.weaponName.classList.toggle('reloading', reloading);
  }

  setDead(dead: boolean, killerName?: string, respawnIn?: number): void {
    this.deadState = { dead, killer: killerName, respawnIn };
    this.deadscreen.classList.toggle('hidden', !dead);
    if (!dead) return;
    const who = killerName ? t('hud.killedBy', { name: killerName }) : t('hud.youDied');
    const when =
      respawnIn !== undefined && respawnIn > 0
        ? t('hud.respawnIn', { s: respawnIn.toFixed(1) })
        : t('hud.pressToRespawn', { key: keyLabel(this.respawnKey) });
    this.deadSub.innerHTML = `${escapeHtml(who)}<br/>${escapeHtml(when)}`;
  }

  // -------------------------------------------------------------- crosshair

  drawCrosshair(state: CrosshairState): void {
    drawCrosshair(this.ctx, CROSSHAIR_SIZE, this.crosshairCfg, state);
  }

  /**
   * Sniper scope. Everything outside the lens is opaque, which is the whole
   * trade: enormous magnification for almost no peripheral vision.
   *
   * `blend` is the aim-down-sights progress, so the glass irises in rather than
   * snapping on, and `sway` nudges the lens so it does not feel welded to the
   * screen while the rifle settles.
   */
  drawScope(blend: number, swayX: number, swayY: number): void {
    this.scopeShown = blend;
    if (blend <= 0.001) {
      if (this.scope.style.opacity !== '0') this.scope.style.opacity = '0';
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.scope.width !== Math.round(w * dpr) || this.scope.height !== Math.round(h * dpr)) {
      this.scope.width = Math.round(w * dpr);
      this.scope.height = Math.round(h * dpr);
      this.scope.style.width = `${w}px`;
      this.scope.style.height = `${h}px`;
    }
    const c = this.scopeCtx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    this.scope.style.opacity = String(blend);

    const cx = w / 2 + swayX;
    const cy = h / 2 + swayY;
    // The lens opens up as the scope comes in, so the transition reads as glass
    // arriving rather than a black card being dropped over the view.
    const r = Math.min(w, h) * (0.28 + 0.14 * blend);

    // Opaque surround, punched through with the lens.
    c.fillStyle = 'rgba(4,6,9,0.985)';
    c.beginPath();
    c.rect(0, 0, w, h);
    c.arc(cx, cy, r, 0, Math.PI * 2, true);
    c.fill();

    // Vignette inside the glass.
    const grad = c.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.72)');
    c.fillStyle = grad;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();

    c.save();
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.clip();

    // Reticle: hairlines with a clear centre, plus range ticks below.
    const line = 'rgba(12,16,20,0.92)';
    const gap = r * 0.045;
    c.strokeStyle = line;
    c.lineWidth = Math.max(1, r * 0.006);
    c.beginPath();
    c.moveTo(cx - r, cy);
    c.lineTo(cx - gap, cy);
    c.moveTo(cx + gap, cy);
    c.lineTo(cx + r, cy);
    c.moveTo(cx, cy - r);
    c.lineTo(cx, cy - gap);
    c.moveTo(cx, cy + gap);
    c.lineTo(cx, cy + r);
    c.stroke();

    c.lineWidth = Math.max(1, r * 0.009);
    for (let i = 1; i <= 4; i++) {
      const y = cy + (r * 0.16) * i;
      const tick = r * (0.05 - i * 0.006);
      c.beginPath();
      c.moveTo(cx - tick, y);
      c.lineTo(cx + tick, y);
      c.stroke();
    }
    // Windage marks either side of centre.
    for (const s of [-1, 1]) {
      for (let i = 1; i <= 3; i++) {
        const x = cx + s * (r * 0.18) * i;
        c.beginPath();
        c.moveTo(x, cy - r * 0.028);
        c.lineTo(x, cy + r * 0.028);
        c.stroke();
      }
    }

    c.fillStyle = 'rgba(255,72,72,0.95)';
    c.beginPath();
    c.arc(cx, cy, Math.max(1, r * 0.008), 0, Math.PI * 2);
    c.fill();
    c.restore();

    // Lens rim: a bright inner hairline and a soft outer bloom.
    c.strokeStyle = 'rgba(150,205,255,0.16)';
    c.lineWidth = Math.max(1, r * 0.012);
    c.beginPath();
    c.arc(cx, cy, r * 0.995, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.lineWidth = Math.max(2, r * 0.03);
    c.beginPath();
    c.arc(cx, cy, r + r * 0.015, 0, Math.PI * 2);
    c.stroke();
  }

  get scopeOpacity(): number {
    return this.scopeShown;
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
      ? `${k}${escapeHtml(victim)}</span><span class="sep">${escapeHtml(t('hud.fellOut'))}</span>`
      : `${k}${escapeHtml(killer)}</span><span class="sep">${escapeHtml(weaponName(weapon))}</span><span>${escapeHtml(victim)}</span>`;
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
    this.lastRows = rows;
    for (const r of rows) this.names.set(r.id, r.name);
    const sorted = [...rows].sort((a, b) => b.score - a.score || b.kills - a.kills);
    this.scoreBody.innerHTML = sorted
      .map(
        (r) =>
          `<tr class="${r.id === this.selfId ? 'self' : ''}"><td>${escapeHtml(r.name)}</td><td class="num">${r.kills}</td><td class="num">${r.deaths}</td><td class="num">${r.score}</td><td class="num">${r.ping}</td></tr>`,
      )
      .join('');
    const count = rows.length === 1 ? t('hud.playerCountOne') : t('hud.playerCount', { n: rows.length });
    this.scoreSub.textContent = `${count} · ${t('hud.mode')}`;
  }

  toggleScoreboard(visible: boolean): void {
    this.scoreboard.classList.toggle('hidden', !visible);
  }

  setMatch(remainingMs: number, killLimit: number, intermission: boolean, leader?: ScoreRow): void {
    const s = Math.max(0, Math.floor(remainingMs / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    this.matchbar.innerHTML = intermission
      ? `<span>${escapeHtml(t('hud.matchOver'))}</span><span class="dim">${escapeHtml(t('hud.nextRound', { time: `${mm}:${ss}` }))}</span>`
      : `<span>${mm}:${ss}</span><span class="dim">${escapeHtml(t('hud.firstTo', { n: killLimit }))}</span>` +
        (leader
          ? `<span class="dim">${escapeHtml(t('hud.leader', { name: leader.name, kills: leader.kills }))}</span>`
          : '');
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

/** Localised weapon name, falling back to the canonical one. */
function weaponName(id: WeaponId): string {
  const w = WEAPONS[id];
  const localised = t(w.nameKey);
  return localised === w.nameKey ? w.name : localised;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
