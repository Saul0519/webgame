import './style.css';
import { Game } from './game/Game.js';
import { Hud } from './ui/Hud.js';
import { Menu, type StartRequest } from './ui/Menu.js';

const app = document.getElementById('app')!;

const loading = document.createElement('div');
loading.className = 'loading hidden';
loading.textContent = 'Building arena…';
app.appendChild(loading);

const hud = new Hud(app);
let game: Game | null = null;

const menu = new Menu(app, async ({ room, settings, offline, fillTo }: StartRequest) => {
  loading.classList.remove('hidden');
  // Let the browser paint the loading state before the (synchronous) texture
  // and geometry build blocks the main thread.
  await new Promise((r) => setTimeout(r, 30));

  const g = new Game(app, hud, { ...settings, offline, fillTo, botSkill: settings.botSkill }, (reason) => {
    g.dispose();
    game = null;
    hud.hide();
    menu.show(`Disconnected: ${reason}`);
  });

  try {
    await g.connect(room, settings.name, fillTo);
  } catch (err) {
    g.dispose();
    loading.classList.add('hidden');
    throw err;
  }

  game = g;
  (window as unknown as { __game?: Game }).__game = g;
  loading.classList.add('hidden');
  menu.hide();
  g.start();
  hud.setPointerHint(true);
});

window.addEventListener('beforeunload', () => game?.dispose());
