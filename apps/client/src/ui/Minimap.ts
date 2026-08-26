import type { Brush, GameMap } from '@webgame/shared';

const SMALL = 190;
const LARGE = 460;
/** How long a gunfire ping stays on the map. */
const PING_MS = 2600;

interface Ping {
  x: number;
  z: number;
  t: number;
  colour: string;
}

/**
 * Top-down map of the arena. The level is rendered once into an offscreen
 * canvas from the same brushes the server collides against, so it can never
 * drift from the real geometry.
 *
 * Enemies are deliberately not drawn continuously — that would be a wallhack.
 * Instead the map pings whoever fires, which is what actually helps you find
 * the fight.
 */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly span: number;
  private pings: Ping[] = [];
  private mode: 0 | 1 | 2 = 1;
  private size = SMALL;

  constructor(parent: HTMLElement, map: GameMap) {
    const pad = 1;
    this.minX = map.bounds.min[0] - pad;
    this.minZ = map.bounds.min[2] - pad;
    this.span = Math.max(map.bounds.max[0] - this.minX, map.bounds.max[2] - this.minZ) + pad;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.base = document.createElement('canvas');
    this.base.width = LARGE;
    this.base.height = LARGE;
    this.drawBase(map);
    this.applyMode();
  }

  /** Cycles off → small → large. */
  cycle(): number {
    this.mode = ((this.mode + 1) % 3) as 0 | 1 | 2;
    this.applyMode();
    return this.mode;
  }

  setMode(mode: number): void {
    const next = (Math.max(0, Math.min(2, Math.round(mode))) | 0) as 0 | 1 | 2;
    if (next === this.mode) return;
    this.mode = next;
    this.applyMode();
  }

  private applyMode(): void {
    this.canvas.classList.toggle('hidden', this.mode === 0);
    this.canvas.classList.toggle('large', this.mode === 2);
    this.size = this.mode === 2 ? LARGE : SMALL;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private toBase(v: number, min: number): number {
    return ((v - min) / this.span) * LARGE;
  }

  private drawBase(map: GameMap): void {
    const c = this.base.getContext('2d')!;
    c.fillStyle = '#0a0e16';
    c.fillRect(0, 0, LARGE, LARGE);

    // Roofs and the ceiling would paint over everything; keep to what you walk
    // on and bump into. Sorted by height so upper decks draw over the floor.
    const drawable = map.brushes
      .filter((b) => !b.nonSolid && b.min[1] < 10)
      .sort((a, b) => a.max[1] - b.max[1]);

    for (const b of drawable) {
      const x0 = this.toBase(b.min[0], this.minX);
      const z0 = this.toBase(b.min[2], this.minZ);
      const w = Math.max(1, this.toBase(b.max[0], this.minX) - x0);
      const h = Math.max(1, this.toBase(b.max[2], this.minZ) - z0);
      c.fillStyle = shadeFor(b);
      c.fillRect(x0, z0, w, h);
    }

    // Soft outline so the arena silhouette reads at small sizes.
    c.strokeStyle = 'rgba(150, 205, 255, 0.25)';
    c.lineWidth = 2;
    c.strokeRect(1, 1, LARGE - 2, LARGE - 2);
  }

  ping(x: number, z: number, colour = '#ffcf6e'): void {
    this.pings.push({ x, z, t: performance.now(), colour });
    if (this.pings.length > 24) this.pings.shift();
  }

  draw(selfX: number, selfZ: number, yaw: number, dead: boolean): void {
    if (this.mode === 0) return;
    const s = this.size;
    const c = this.ctx;
    c.clearRect(0, 0, s, s);
    c.drawImage(this.base, 0, 0, s, s);

    const px = ((selfX - this.minX) / this.span) * s;
    const pz = ((selfZ - this.minZ) / this.span) * s;

    const now = performance.now();
    this.pings = this.pings.filter((p) => now - p.t < PING_MS);
    for (const p of this.pings) {
      const k = 1 - (now - p.t) / PING_MS;
      const x = ((p.x - this.minX) / this.span) * s;
      const z = ((p.z - this.minZ) / this.span) * s;
      c.strokeStyle = p.colour;
      c.globalAlpha = k * 0.85;
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(x, z, (1 - k) * (s * 0.05) + 2, 0, Math.PI * 2);
      c.stroke();
      c.globalAlpha = k;
      c.fillStyle = p.colour;
      c.beginPath();
      c.arc(x, z, 2.2, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;

    // Player arrow. yaw 0 looks down -Z, which is up on the map.
    c.save();
    c.translate(px, pz);
    c.rotate(-yaw);
    c.fillStyle = dead ? '#ff6b6b' : '#7fe0ff';
    c.strokeStyle = 'rgba(0,0,0,0.75)';
    c.lineWidth = 1.5;
    const r = s === LARGE ? 9 : 6;
    c.beginPath();
    c.moveTo(0, -r);
    c.lineTo(r * 0.62, r * 0.72);
    c.lineTo(0, r * 0.32);
    c.lineTo(-r * 0.62, r * 0.72);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }
}

function shadeFor(b: Brush): string {
  const top = b.max[1];
  if (top <= 0.05) return '#1b2432'; // ground plane
  if (top < 1.2) return '#26313f';
  if (top < 3.5) return '#33404f';
  if (top < 8) return '#41505f';
  return '#4d5d6d';
}
