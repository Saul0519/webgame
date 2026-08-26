import './style.css';
import { Game } from './game/Game.js';
import { Hud } from './ui/Hud.js';
import { Menu, type StartRequest } from './ui/Menu.js';
import { initLang, onLangChange, t } from './ui/i18n.js';

initLang();

const app = document.getElementById('app')!;

const loading = document.createElement('div');
loading.className = 'loading hidden';
loading.textContent = t('menu.buildingArena');
app.appendChild(loading);
onLangChange(() => {
  loading.textContent = t('menu.buildingArena');
});

const hud = new Hud(app);
let game: Game | null = null;

let starting = false;

const menu = new Menu(app, async ({ room, settings, offline, fillTo, tier }: StartRequest) => {
  // A stray Space or Enter reaching a still-focused menu button used to start a
  // second match on top of the running one, which tore the canvas out from
  // under the first. One match at a time, always.
  if (starting || game) return;
  starting = true;
  try {
    loading.classList.remove('hidden');
    // Let the browser paint the loading state before the (synchronous) texture
    // and geometry build blocks the main thread.
    await new Promise((r) => setTimeout(r, 30));

    const g = new Game(app, hud, { ...settings, offline, fillTo }, (reason) => {
      g.dispose();
      game = null;
      hud.hide();
      menu.show(t('toast.disconnected', { reason }));
    });

    try {
      await g.connect(room, settings.name, fillTo, tier);
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
  } finally {
    starting = false;
  }
});

window.addEventListener('beforeunload', () => game?.dispose());
