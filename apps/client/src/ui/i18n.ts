/**
 * Tiny translation runtime.
 *
 * Every user-facing string in the client goes through `t()`. Switching language
 * fires the listeners, and each piece of UI re-renders itself from the same
 * dictionary — there is no reload, because a language switch mid-match must not
 * drop you out of the match.
 */

export type Lang = 'en' | 'ko';

export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'ko', label: '한국어' },
];

type Dict = Record<string, string>;

const en: Dict = {
  // --- menu ---
  'menu.tagline': 'Multiplayer Arena FPS',
  'menu.callsign': 'Callsign',
  'menu.namePlaceholder': 'Enter a name',
  'menu.liveServers': 'Live servers',
  'menu.quickMatch': 'Quick match',
  'menu.solo': 'Solo vs bots',
  'menu.settings': 'Settings',
  'menu.joinByCode': 'Join by match code',
  'menu.codePlaceholder': 'e.g. K7QW2',
  'menu.join': 'Join',
  'menu.createPrivate': 'Create private match',
  'menu.hint':
    'Pick a server above, or hit <b>Quick match</b> for the busiest one. Bots fill empty slots and step aside as players arrive — set <b>Bots: Off</b> in Settings for a clean lobby. Difficulty and bot count apply to whichever room you open first; joining a running match inherits its settings.',
  'menu.controlsTitle': 'Controls',
  'menu.serverUnreachable': 'Server unreachable — Solo vs bots still works.',
  'menu.noRooms': 'No servers yet — Quick match will open one.',
  'menu.connecting': 'Connecting to {code}…',
  'menu.findingMatch': 'Finding a match…',
  'menu.creatingMatch': 'Creating match…',
  'menu.buildingArena': 'Building arena…',
  'menu.codeLength': 'Match codes are 5 characters.',
  'menu.connectFailed': 'Connection failed: {err}',
  'menu.unreachable': 'Could not reach the server: {err}',
  'menu.startFailed': 'Could not start: {err}',
  'menu.botsSuffix': '+{n} bots',

  // --- HUD ---
  'weapon.rifle': 'VK-7 Rifle',
  'weapon.smg': 'MP-9 Vector',
  'weapon.shotgun': 'Breach-12',
  'weapon.sniper': 'AX-50 Marksman',

  'hud.health': 'Health',
  'hud.ammo': 'Ammo',
  'hud.reloading': 'Reloading…',
  'hud.scoreboard': 'Scoreboard',
  'hud.colPlayer': 'Player',
  'hud.colKills': 'K',
  'hud.colDeaths': 'D',
  'hud.colScore': 'Score',
  'hud.colPing': 'Lag',
  'hud.mode': 'Deathmatch',
  'hud.playerCount': '{n} players',
  'hud.playerCountOne': '1 player',
  'hud.eliminated': 'Eliminated',
  'hud.killedBy': 'Killed by {name}',
  'hud.youDied': 'You died',
  'hud.respawnIn': 'Respawning in {s}s',
  'hud.pressToRespawn': 'Press {key} to respawn',
  'hud.clickToLock': 'Click to lock the mouse',
  'hud.chatPlaceholder': 'Say something and press Enter',
  'hud.matchOver': 'Match over',
  'hud.nextRound': 'next round {time}',
  'hud.firstTo': 'first to {n}',
  'hud.leader': 'leader {name} {kills}',
  'hud.fellOut': 'fell out of the world',
  'hud.offlineMatch': 'offline match',
  'hud.rtt': '{n} ms rtt',
  'hud.tick': '{ms} ms tick  {draws} draws',

  // --- toasts / status ---
  'toast.muted': 'Audio muted',
  'toast.unmuted': 'Audio on',
  'toast.eliminated': 'Eliminated',
  'toast.matchOver': 'Match over',
  'toast.roundStart': 'Round start',
  'toast.lockBlocked': 'Mouse lock blocked — open in a tab for full aim',
  'toast.disconnected': 'Disconnected: {reason}',
  'toast.fullscreenOn': 'Fullscreen on — browser shortcuts are captured',
  'toast.fullscreenOff': 'Fullscreen off',

  // --- pause ---
  'pause.title': 'Settings',
  'pause.resume': 'Resume',
  'pause.leave': 'Leave match',

  // --- settings groups ---
  'set.group.language': 'Language',
  'set.group.mouse': 'Mouse',
  'set.group.keys': 'Controls',
  'set.group.view': 'View',
  'set.group.audio': 'Audio',
  'set.group.crosshair': 'Crosshair',
  'set.group.match': 'Match',
  'set.group.graphics': 'Graphics',
  'set.group.hud': 'HUD',

  'set.language': 'Language',
  'set.sensitivity': 'Sensitivity',
  'set.adsSensitivity': 'Aim-down-sights multiplier',
  'set.mouseSmoothing': 'Smoothing',
  'set.invertY': 'Invert vertical look',
  'set.rawInput': 'Raw mouse input',
  'set.fov': 'Field of view',
  'set.brightness': 'Brightness',
  'set.viewmodelSway': 'Weapon sway',
  'set.viewBob': 'View bob',
  'set.volume': 'Volume',
  'set.muted': 'Mute all sound',
  'set.botFill': 'Bots',
  'set.botSkill': 'Bot difficulty',
  'set.defaultWeapon': 'Starting weapon',
  'set.quality': 'Quality',
  'set.renderScale': 'Resolution',
  'set.dynamicResolution': 'Auto-adjust resolution for frame rate',
  'set.screenEffects': 'Film grain and vignette',
  'set.minimapMode': 'Map',
  'set.showFps': 'Performance readout',
  'set.fullscreen': 'Capture browser shortcuts in fullscreen',
  'set.fullscreenHelp':
    'Some browser shortcuts (Ctrl+W closes the tab) cannot be blocked by a web page. Fullscreen lets the game capture them instead.',

  // option labels
  'opt.off': 'Off',
  'opt.on': 'On',
  'opt.small': 'Small',
  'opt.large': 'Large',
  'opt.low': 'Low',
  'opt.medium': 'Medium',
  'opt.high': 'High',
  'opt.white': 'White',
  'opt.green': 'Green',
  'opt.cyan': 'Cyan',
  'opt.amber': 'Amber',
  'opt.pink': 'Pink',
  'opt.red': 'Red',
  'opt.rookie': 'Rookie',
  'opt.regular': 'Regular',
  'opt.veteran': 'Veteran',
  'opt.elite': 'Elite',
  'opt.rifle': 'Rifle',
  'opt.smg': 'SMG',
  'opt.shotgun': 'Shotgun',
  'opt.sniper': 'Sniper',

  // --- crosshair editor ---
  'xh.title': 'Crosshair',
  'xh.preview': 'Preview',
  'xh.colour': 'Colour',
  'xh.customColour': 'Custom colour',
  'xh.outline': 'Outline',
  'xh.outlineOpacity': 'Outline opacity',
  'xh.outlineThickness': 'Outline thickness',
  'xh.dot': 'Centre dot',
  'xh.dotOpacity': 'Dot opacity',
  'xh.dotSize': 'Dot size',
  'xh.innerLines': 'Inner lines',
  'xh.outerLines': 'Outer lines',
  'xh.opacity': 'Opacity',
  'xh.length': 'Length',
  'xh.thickness': 'Thickness',
  'xh.offset': 'Offset',
  'xh.moveError': 'Movement error',
  'xh.fireError': 'Firing error',
  'xh.code': 'Share code',
  'xh.copy': 'Copy',
  'xh.import': 'Import',
  'xh.reset': 'Reset',
  'xh.copied': 'Crosshair code copied',
  'xh.imported': 'Crosshair imported',
  'xh.badCode': 'That code could not be read',

  // --- keybinds ---
  'key.forward': 'Move forward',
  'key.back': 'Move back',
  'key.left': 'Strafe left',
  'key.right': 'Strafe right',
  'key.jump': 'Jump',
  'key.crouch': 'Crouch',
  'key.walk': 'Walk',
  'key.reload': 'Reload',
  'key.weapon1': 'Weapon 1',
  'key.weapon2': 'Weapon 2',
  'key.weapon3': 'Weapon 3',
  'key.weapon4': 'Weapon 4',
  'key.scoreboard': 'Scoreboard',
  'key.map': 'Cycle map',
  'key.chat': 'Chat',
  'key.mute': 'Mute',
  'key.fullscreen': 'Toggle fullscreen',
  'key.fire': 'Fire',
  'key.ads': 'Aim',
  'key.weapons': 'Switch weapon',
  'key.press': 'Press a key…',
  'key.reset': 'Reset controls',
  'key.ctrlWarning': 'Ctrl and Alt combinations may be taken by the browser. Play in fullscreen to keep them.',
};

const ko: Dict = {
  'menu.tagline': '멀티플레이 아레나 FPS',
  'menu.callsign': '닉네임',
  'menu.namePlaceholder': '이름을 입력하세요',
  'menu.liveServers': '진행 중인 서버',
  'menu.quickMatch': '빠른 대전',
  'menu.solo': '봇과 혼자 하기',
  'menu.settings': '설정',
  'menu.joinByCode': '매치 코드로 참가',
  'menu.codePlaceholder': '예: K7QW2',
  'menu.join': '참가',
  'menu.createPrivate': '비공개 매치 만들기',
  'menu.hint':
    '위에서 서버를 고르거나 <b>빠른 대전</b>을 누르면 가장 활발한 방에 들어갑니다. 봇이 빈자리를 채우고 사람이 들어오면 물러납니다 — 설정에서 <b>봇: 끄기</b>로 두면 봇 없는 로비가 됩니다. 난이도와 봇 수는 처음 여는 방에만 적용되고, 이미 진행 중인 매치에 들어가면 그 방의 설정을 따릅니다.',
  'menu.controlsTitle': '조작',
  'menu.serverUnreachable': '서버에 연결할 수 없습니다 — 봇과 혼자 하기는 됩니다.',
  'menu.noRooms': '아직 서버가 없습니다 — 빠른 대전을 누르면 하나 열립니다.',
  'menu.connecting': '{code} 에 접속 중…',
  'menu.findingMatch': '매치를 찾는 중…',
  'menu.creatingMatch': '매치를 만드는 중…',
  'menu.buildingArena': '아레나를 만드는 중…',
  'menu.codeLength': '매치 코드는 5자리입니다.',
  'menu.connectFailed': '접속 실패: {err}',
  'menu.unreachable': '서버에 연결할 수 없습니다: {err}',
  'menu.startFailed': '시작할 수 없습니다: {err}',
  'menu.botsSuffix': '봇 {n}',

  'weapon.rifle': 'VK-7 소총',
  'weapon.smg': 'MP-9 기관단총',
  'weapon.shotgun': 'Breach-12 샷건',
  'weapon.sniper': 'AX-50 저격총',

  'hud.health': '체력',
  'hud.ammo': '탄약',
  'hud.reloading': '재장전 중…',
  'hud.scoreboard': '점수판',
  'hud.colPlayer': '플레이어',
  'hud.colKills': '킬',
  'hud.colDeaths': '데스',
  'hud.colScore': '점수',
  'hud.colPing': '지연',
  'hud.mode': '데스매치',
  'hud.playerCount': '{n}명',
  'hud.playerCountOne': '1명',
  'hud.eliminated': '처치됨',
  'hud.killedBy': '{name} 에게 당했습니다',
  'hud.youDied': '사망했습니다',
  'hud.respawnIn': '{s}초 후 리스폰',
  'hud.pressToRespawn': '{key} 키를 눌러 리스폰',
  'hud.clickToLock': '클릭하면 마우스가 고정됩니다',
  'hud.chatPlaceholder': '메시지를 입력하고 Enter',
  'hud.matchOver': '매치 종료',
  'hud.nextRound': '다음 라운드 {time}',
  'hud.firstTo': '{n}킬 선취',
  'hud.leader': '선두 {name} {kills}',
  'hud.fellOut': '맵 밖으로 떨어짐',
  'hud.offlineMatch': '오프라인 매치',
  'hud.rtt': '{n} ms 지연',
  'hud.tick': '틱 {ms} ms  드로우 {draws}',

  'toast.muted': '소리 껐습니다',
  'toast.unmuted': '소리 켰습니다',
  'toast.eliminated': '처치!',
  'toast.matchOver': '매치 종료',
  'toast.roundStart': '라운드 시작',
  'toast.lockBlocked': '마우스 고정이 차단되었습니다 — 새 탭에서 열면 정상 조준됩니다',
  'toast.disconnected': '연결 끊김: {reason}',
  'toast.fullscreenOn': '전체 화면 — 브라우저 단축키를 게임이 가져갑니다',
  'toast.fullscreenOff': '전체 화면 해제',

  'pause.title': '설정',
  'pause.resume': '계속하기',
  'pause.leave': '매치 나가기',

  'set.group.language': '언어',
  'set.group.mouse': '마우스',
  'set.group.keys': '조작키',
  'set.group.view': '화면',
  'set.group.audio': '소리',
  'set.group.crosshair': '조준점',
  'set.group.match': '매치',
  'set.group.graphics': '그래픽',
  'set.group.hud': 'HUD',

  'set.language': '언어',
  'set.sensitivity': '감도',
  'set.adsSensitivity': '정조준 감도 배율',
  'set.mouseSmoothing': '부드럽게',
  'set.invertY': '상하 반전',
  'set.rawInput': '가속 없는 원시 입력',
  'set.fov': '시야각',
  'set.brightness': '밝기',
  'set.viewmodelSway': '총기 흔들림',
  'set.viewBob': '화면 흔들림',
  'set.volume': '음량',
  'set.muted': '모든 소리 끄기',
  'set.botFill': '봇',
  'set.botSkill': '봇 난이도',
  'set.defaultWeapon': '시작 무기',
  'set.quality': '품질',
  'set.renderScale': '해상도',
  'set.dynamicResolution': '프레임에 맞춰 해상도 자동 조절',
  'set.screenEffects': '필름 그레인과 비네팅',
  'set.minimapMode': '미니맵',
  'set.showFps': '성능 표시',
  'set.fullscreen': '전체 화면으로 브라우저 단축키 잡기',
  'set.fullscreenHelp':
    '일부 브라우저 단축키(Ctrl+W는 탭을 닫습니다)는 웹페이지가 막을 수 없습니다. 전체 화면에서는 게임이 대신 가져갑니다.',

  'opt.off': '끄기',
  'opt.on': '켜기',
  'opt.small': '작게',
  'opt.large': '크게',
  'opt.low': '낮음',
  'opt.medium': '보통',
  'opt.high': '높음',
  'opt.white': '흰색',
  'opt.green': '초록',
  'opt.cyan': '하늘',
  'opt.amber': '노랑',
  'opt.pink': '분홍',
  'opt.red': '빨강',
  'opt.rookie': '초보',
  'opt.regular': '보통',
  'opt.veteran': '숙련',
  'opt.elite': '최정예',
  'opt.rifle': '소총',
  'opt.smg': '기관단총',
  'opt.shotgun': '샷건',
  'opt.sniper': '저격총',

  'xh.title': '조준점',
  'xh.preview': '미리보기',
  'xh.colour': '색상',
  'xh.customColour': '직접 지정',
  'xh.outline': '외곽선',
  'xh.outlineOpacity': '외곽선 불투명도',
  'xh.outlineThickness': '외곽선 두께',
  'xh.dot': '가운데 점',
  'xh.dotOpacity': '점 불투명도',
  'xh.dotSize': '점 크기',
  'xh.innerLines': '안쪽 선',
  'xh.outerLines': '바깥 선',
  'xh.opacity': '불투명도',
  'xh.length': '길이',
  'xh.thickness': '두께',
  'xh.offset': '간격',
  'xh.moveError': '이동 시 벌어짐',
  'xh.fireError': '사격 시 벌어짐',
  'xh.code': '공유 코드',
  'xh.copy': '복사',
  'xh.import': '불러오기',
  'xh.reset': '초기화',
  'xh.copied': '조준점 코드를 복사했습니다',
  'xh.imported': '조준점을 불러왔습니다',
  'xh.badCode': '코드를 읽을 수 없습니다',

  'key.forward': '앞으로',
  'key.back': '뒤로',
  'key.left': '왼쪽으로',
  'key.right': '오른쪽으로',
  'key.jump': '점프',
  'key.crouch': '앉기',
  'key.walk': '걷기',
  'key.reload': '재장전',
  'key.weapon1': '무기 1',
  'key.weapon2': '무기 2',
  'key.weapon3': '무기 3',
  'key.weapon4': '무기 4',
  'key.scoreboard': '점수판',
  'key.map': '미니맵 전환',
  'key.chat': '채팅',
  'key.mute': '음소거',
  'key.fullscreen': '전체 화면',
  'key.fire': '사격',
  'key.ads': '정조준',
  'key.weapons': '무기 전환',
  'key.press': '키를 누르세요…',
  'key.reset': '조작키 초기화',
  'key.ctrlWarning': 'Ctrl·Alt 조합은 브라우저가 먼저 가져갈 수 있습니다. 전체 화면으로 하면 게임이 받습니다.',
};

const DICTS: Record<Lang, Dict> = { en, ko };

const LANG_KEY = 'webgame.lang';
let current: Lang = detect();
const listeners = new Set<() => void>();

function detect(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'ko' || stored === 'en') return stored;
  } catch {
    /* storage unavailable */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return nav.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* storage unavailable */
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    // Korean needs a different face and a slightly looser line height; the
    // stylesheet keys off this attribute rather than sniffing the text.
    document.documentElement.dataset.lang = lang;
  }
  for (const fn of [...listeners]) fn();
}

/** Subscribe to language changes. Returns an unsubscribe function. */
export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Look a string up, substituting `{name}` placeholders. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const s = DICTS[current][key] ?? en[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Apply the stored language to the document without firing listeners. */
export function initLang(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  document.documentElement.dataset.lang = current;
}
