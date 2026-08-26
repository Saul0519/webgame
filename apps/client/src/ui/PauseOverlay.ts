import { SettingsPanel, type GameSettings } from './SettingsPanel.js';
import { onLangChange, t } from './i18n.js';

/**
 * In-game settings, shown whenever pointer lock is lost.
 *
 * It is driven off the pointerlockchange event rather than an Escape key
 * handler: while the pointer is locked, browsers consume Escape to exit lock
 * and do not reliably deliver the keydown, so a key-driven overlay opens only
 * some of the time.
 */
export class PauseOverlay {
  readonly root: HTMLElement;
  private readonly panel: SettingsPanel;
  private open = false;
  private readonly onResume: () => void;
  private readonly onQuit: () => void;
  private readonly title: HTMLElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly quitBtn: HTMLButtonElement;
  private readonly stopLang: () => void;

  constructor(
    parent: HTMLElement,
    settings: GameSettings,
    onChange: (s: GameSettings, key: keyof GameSettings) => void,
    actions: { onResume: () => void; onQuit: () => void },
  ) {
    this.onResume = actions.onResume;
    this.onQuit = actions.onQuit;

    this.root = document.createElement('div');
    this.root.className = 'pause hidden';

    const card = document.createElement('div');
    card.className = 'pause-card';

    const title = document.createElement('h2');
    this.title = title;
    card.appendChild(title);

    // Match options are decided when a match starts, so they would be a lie here.
    this.panel = new SettingsPanel(settings, onChange, { hideMatchStartOnly: true });
    card.appendChild(this.panel.root);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'pause-actions';
    const resume = document.createElement('button');
    this.resumeBtn = resume;
    resume.addEventListener('click', () => this.onResume());
    const quit = document.createElement('button');
    this.quitBtn = quit;
    quit.className = 'ghost';
    quit.addEventListener('click', () => this.onQuit());
    actionsRow.append(resume, quit);
    card.appendChild(actionsRow);

    this.root.appendChild(card);
    parent.appendChild(this.root);

    this.retranslate();
    this.stopLang = onLangChange(() => this.retranslate());

    // The overlay itself is not pointer-locked, so it receives Escape normally.
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.onResume();
      }
    });
  }

  private retranslate(): void {
    this.title.textContent = t('pause.title');
    this.resumeBtn.textContent = t('pause.resume');
    this.quitBtn.textContent = t('pause.leave');
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.root.classList.remove('hidden');
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add('hidden');
  }

  dispose(): void {
    this.stopLang();
    this.panel.dispose();
    this.root.remove();
  }
}
