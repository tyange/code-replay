import { splitNotes, type StageNotes } from './notes';
import { Player, type Playlist } from './player';
import type { Guide, GuideSummary } from './types';
import { BubbleView } from './views/bubble';
import { ControlsView, type ControlAction } from './views/controls';
import { DocView, renderMarkdown } from './views/doc';
import { EditorView } from './views/editor';
import type { IdeView } from './views/ide';
import { Shell, type ShellHost } from './views/shell';
import { snapshotBefore } from './workspace';

const DEFAULT_SPEED = 45;
const BASE = import.meta.env.BASE_URL;

function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

/** Guide titles often start with their own number ("2-3. …"); the id is shown separately */
function stageTitle(id: string, title: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`^\\s*(?:stage\\s*)?${escaped}[.:)]?\\s+`, 'i'), '') || title;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Small per-viewer settings and progress, kept only in this browser */
const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`code-replay:${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`code-replay:${key}`, JSON.stringify(value));
    } catch {
      // storage unavailable: the setting just isn't remembered
    }
  },
};

const progressStore = {
  get: (slug: string) => new Set(storage.get<string[]>(`done:${slug}`, [])),
  set: (slug: string, done: Set<string>) => storage.set(`done:${slug}`, [...done]),
};

const HELP: Array<[string, string]> = [
  ['ls', '가이드 목록 (가이드 안에서는 단계 목록)'],
  ['cd <가이드>', '가이드 열기 · cd .. 으로 나가기'],
  ['play [단계]', '단계 재생 · play next / play prev'],
  ['read [단계|intro]', '설명 전체 보기'],
  ['stages · branches', '단계 / 실험 브랜치 목록'],
  ['pause · resume · restart', '재생 제어'],
  ['next · prev', '다음 / 이전 커밋'],
  ['speed [ms]', '타이핑 속도 (글자당 ms, 작을수록 빠름)'],
  ['notes on|off', '말풍선 설명 켜기 / 끄기'],
  ['autopause on|off', '말풍선이 뜰 때 멈추기'],
  ['fill', '내 코드를 이 커밋 직전 상태로 채우기'],
  ['diff', '내 코드와 재생 코드 비교'],
  ['done [단계]', '단계를 완료로 표시 / 해제'],
  ['clear', '화면 지우기 (Ctrl+L)'],
];

const KEYS: Array<[string, string]> = [
  ['Alt+Space', '재생 / 일시정지 · 말풍선 계속 (에디터에서도 됨)'],
  ['Alt+, · Alt+.', '한 줄 뒤로 / 앞으로'],
  ['Alt+[ · Alt+]', '이전 / 다음 커밋'],
  ['Alt+- · Alt+=', '느리게 / 빠르게'],
  ['Alt+/', '명령어 입력'],
  ['', '에디터 밖에서는 Alt 없이도:'],
  ['Space', '재생 / 일시정지'],
  ['h · l / H · L', '한 줄 / 변경 단위 뒤로·앞으로'],
  ['p · n / [ · ]', '이전·다음 커밋 / 이전·다음 단계'],
  ['r', '이 커밋 처음부터'],
];

export class App implements ShellHost {
  private guides: GuideSummary[] = [];
  private guide: Guide | null = null;
  private readonly cache = new Map<string, Guide>();
  private readonly player = new Player(storage.get('speed', DEFAULT_SPEED));
  private readonly editor = new EditorView($('#editor-title'), $('#editor'));
  /** Monaco is big, so the editor loads only once a guide is opened */
  private ide: IdeView | null = null;
  private idePromise: Promise<IdeView> | null = null;
  private readonly bubble = new BubbleView($('#bubble'), $('#bubble-chip'));
  private readonly modalDoc = new DocView($('#modal-doc'));
  private readonly controls: ControlsView;
  private readonly shell: Shell;
  private notes: StageNotes = { byCommit: new Map(), end: '' };
  private notesOn = storage.get('notes', true);
  private autopause = storage.get('autopause', true);
  private followedPath = '';
  private fillArmed = 0;
  private dirty = true;

  constructor() {
    this.controls = new ControlsView(
      $('#controls'),
      (action) => this.control(action),
      (commit) => this.player.seekCommit(commit),
    );
    this.shell = new Shell(
      $('#shell-log'),
      $('#shell-form') as HTMLFormElement,
      $('#shell-input') as HTMLInputElement,
      $('#shell-prompt'),
      this,
    );
    this.player.onChange = () => {
      this.dirty = true;
    };
    this.player.onCommit = (index) => this.commitStarted(index);
    this.player.onEnd = () => this.stageEnded();

    $('#stage-list').addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-play]');
      if (item?.dataset.play) {
        document.body.classList.remove('drawer-open');
        this.shell.exec(`play ${item.dataset.play}`);
      }
    });
    $('#home').addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
      if (item?.dataset.cmd) this.shell.exec(item.dataset.cmd);
    });
    document.querySelectorAll<HTMLElement>('[data-open-doc]').forEach((button) =>
      button.addEventListener('click', () =>
        this.shell.exec(button.dataset.openDoc === 'intro' ? 'read intro' : 'read'),
      ),
    );
    $('#toggle-drawer').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
    $('#toggle-shell').addEventListener('click', () => document.body.classList.toggle('shell-tall'));
    $('#modal-close').addEventListener('click', () => this.closeModal());
    $('#modal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) this.closeModal();
    });
    const follow = $('#ide-follow') as HTMLInputElement;
    follow.checked = storage.get('follow', true);
    follow.addEventListener('change', () => {
      if (this.ide) this.ide.follow = follow.checked;
      storage.set('follow', follow.checked);
      this.followedPath = '';
      this.dirty = true;
    });
    $('#ide-compare').addEventListener('click', () => this.shell.exec('diff'));
    $('#ide-fill').addEventListener('click', () => this.fill());
    $('#ide-download').addEventListener('click', () => this.ide?.download());
    // Capture phase, so Alt shortcuts work even while typing in the editor
    document.addEventListener('keydown', (event) => this.onAltKey(event), true);
    document.addEventListener('keydown', (event) => this.onKey(event));
    window.addEventListener('hashchange', () => void this.route());
  }

  async start(): Promise<void> {
    this.banner();
    try {
      const response = await fetch(`${BASE}data/index.json`);
      this.guides = (await response.json()) as GuideSummary[];
    } catch {
      this.shell.print('가이드 목록을 불러오지 못했습니다.', 'error');
    }
    await this.route();
    if (!this.guide) this.shell.exec('ls');
    const loop = (now: number) => {
      this.player.tick(now);
      if (this.dirty) {
        this.dirty = false;
        this.render();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.shell.focus();
  }

  private loadIde(): Promise<IdeView> {
    this.idePromise ??= import('./views/ide').then(({ IdeView }) => {
      const ide = new IdeView($('#ide'), $('#ide-tabs'));
      ide.follow = ($('#ide-follow') as HTMLInputElement).checked;
      ide.onFilesChange = () => {
        $('#ide-empty').hidden = ide.paths.length > 0;
      };
      this.ide = ide;
      this.followedPath = '';
      this.dirty = true;
      return ide;
    });
    return this.idePromise;
  }

  // ---------------------------------------------------------------- routing

  private async route(): Promise<void> {
    // Split before decoding: branch names like exp/refs are encoded as one part
    const [slug, stage, commit] = location.hash
      .replace(/^#\/?/, '')
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    if (!slug) {
      this.leaveGuide();
      return;
    }
    if (this.guide?.slug !== slug && !(await this.openGuide(slug))) return;
    const key = stage ?? this.guide?.stages[0]?.id;
    if (key && key !== this.player.playlist?.key) {
      this.playStage(key, Math.max(Number(commit ?? 1) - 1, 0), false);
    }
  }

  private setHash(): void {
    const parts = this.guide ? [this.guide.slug] : [];
    if (this.guide && this.player.playlist) {
      parts.push(this.player.playlist.key, String(this.player.commitIndex + 1));
    }
    const hash = `#/${parts.map(encodeURIComponent).join('/')}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  // ---------------------------------------------------------------- guides

  private async loadGuide(slug: string): Promise<Guide | null> {
    const cached = this.cache.get(slug);
    if (cached) return cached;
    try {
      const response = await fetch(`${BASE}data/${encodeURIComponent(slug)}.json`);
      if (!response.ok) return null;
      const guide = (await response.json()) as Guide;
      this.cache.set(slug, guide);
      return guide;
    } catch {
      return null;
    }
  }

  private async openGuide(slug: string): Promise<boolean> {
    const known = this.guides.find((g) => g.slug === slug);
    if (!known) {
      this.shell.print(`cd: ${slug}: 그런 가이드가 없습니다. ls 로 목록을 보세요.`, 'error');
      return false;
    }
    this.shell.print(`불러오는 중… ${known.title}`, 'muted');
    const guide = await this.loadGuide(slug);
    if (!guide) {
      this.shell.print(`${slug} 를 불러오지 못했습니다.`, 'error');
      return false;
    }
    this.guide = guide;
    document.body.classList.add('in-guide');
    void this.loadIde().then((ide) => {
      // The user may have left or switched guides while the editor was loading
      if (this.guide?.slug === slug) ide.load(slug);
      this.followedPath = '';
      this.dirty = true;
    });
    this.followedPath = '';
    this.shell.printHtml(
      `<b>${escapeHtml(guide.title)}</b> — ${escapeHtml(guide.summary)}<br>` +
        `<span class="muted">단계 ${guide.stages.length}개. </span><a data-cmd="play">play</a><span class="muted"> 로 첫 단계부터, </span><a data-cmd="stages">stages</a><span class="muted"> 로 목록을, </span><a data-cmd="read intro">read intro</a><span class="muted"> 로 소개를 봅니다.</span>`,
    );
    this.shell.updatePrompt();
    this.dirty = true;
    return true;
  }

  private leaveGuide(): void {
    this.guide = null;
    this.player.playlist = null;
    this.player.pause();
    this.bubble.clear();
    this.ide?.unload();
    document.body.classList.remove('in-guide');
    this.shell.updatePrompt();
    this.setHash();
    this.dirty = true;
  }

  private playlistFor(key: string): Playlist | null {
    const guide = this.guide;
    if (!guide) return null;
    const stage = guide.stages.find((s) => s.id === key);
    if (stage) return { key: stage.id, title: stageTitle(stage.id, stage.title), commits: stage.commits };
    const branch = guide.branches.find((b) => b.name === key);
    if (branch) return { key: branch.name, title: branch.title, commits: branch.commits };
    return null;
  }

  private docFor(key: string | undefined): string {
    const guide = this.guide;
    if (!guide || !key) return '';
    return guide.stages.find((s) => s.id === key)?.doc ?? guide.branches.find((b) => b.name === key)?.doc ?? '';
  }

  private playStage(key: string, commit = 0, autoplay = true): boolean {
    const playlist = this.playlistFor(key);
    if (!playlist) {
      this.shell.print(`play: ${key}: 그런 단계가 없습니다. stages 로 목록을 보세요.`, 'error');
      return false;
    }
    if (playlist.commits.length === 0) {
      this.shell.print(`${key} 단계에는 재생할 커밋이 없습니다. read 로 설명을 보세요.`, 'muted');
    }
    this.notes = splitNotes(this.docFor(key), playlist.commits);
    this.bubble.clear();
    this.player.load(playlist, commit, autoplay && playlist.commits.length > 0);
    this.setHash();
    this.dirty = true;
    return true;
  }

  // ---------------------------------------------------------------- narration

  private commitStarted(index: number): void {
    const key = this.player.playlist?.key;
    const note = this.notes.byCommit.get(index);
    if (!key || !note || !this.notesOn) {
      this.bubble.collapse();
      return;
    }
    const path = this.player.commit?.files[0]?.path ?? '';
    const title = index === 0 ? '이 단계에서 할 일' : `다음 파일 · ${path}`;
    this.bubble.show(`${key}:${index}`, title, note, [
      { label: '계속 ▶ <kbd>Alt+Space</kbd>', primary: true, run: () => this.continueFromBubble() },
      { label: '접어 두고 재생', run: () => this.continueFromBubble() },
    ]);
    if (this.autopause && this.player.playing) this.player.pause();
  }

  private continueFromBubble(): void {
    this.bubble.collapse();
    if (!this.player.ended) this.player.play();
  }

  private stageEnded(): void {
    const guide = this.guide;
    const key = this.player.playlist?.key;
    if (!guide || !key) return;
    const done = progressStore.get(guide.slug);
    done.add(key);
    progressStore.set(guide.slug, done);
    const index = guide.stages.findIndex((s) => s.id === key);
    const next = guide.stages[index + 1];
    this.shell.printHtml(
      `<span class="ok">✓ ${escapeHtml(key)} 단계 재생 끝.</span> ` +
        (next
          ? `<span class="muted">다음 단계:</span> <a data-cmd="play ${escapeHtml(next.id)}">play ${escapeHtml(next.id)}</a> <span class="muted">— ${escapeHtml(stageTitle(next.id, next.title))}</span>`
          : '<span class="muted">마지막 단계입니다.</span>'),
    );
    const body = this.notes.end || '이 단계의 코드를 모두 재생했습니다.';
    const actions = [
      ...(next
        ? [{ label: `다음 단계 ${escapeHtml(next.id)} ▶`, primary: true, run: () => this.shell.exec(`play ${next.id}`) }]
        : []),
      { label: '이 단계 처음부터', run: () => this.shell.exec(`play ${key}`) },
      { label: '접기', run: () => this.bubble.collapse() },
    ];
    this.bubble.show(`${key}:end`, '단계 마무리 — 확인해 볼 것', body, actions);
  }

  // ---------------------------------------------------------------- my code

  private fill(): void {
    const guide = this.guide;
    const key = this.player.playlist?.key;
    if (!guide || !key) {
      this.shell.print('fill: 먼저 단계를 여세요.', 'error');
      return;
    }
    const button = $('#ide-fill');
    if (Date.now() - this.fillArmed > 4000) {
      this.fillArmed = Date.now();
      button.textContent = '정말 덮어쓸까요? 한 번 더';
      button.classList.add('armed');
      this.shell.print('fill: 내 코드를 지금 커밋 직전 상태로 덮어씁니다. 4초 안에 한 번 더 누르면 실행합니다. (되돌리기: 에디터에서 Ctrl/Cmd+Z)', 'muted');
      window.setTimeout(() => {
        button.textContent = '여기까지 채우기';
        button.classList.remove('armed');
      }, 4000);
      return;
    }
    this.fillArmed = 0;
    button.textContent = '여기까지 채우기';
    button.classList.remove('armed');
    const files = snapshotBefore(guide, key, this.player.commitIndex);
    const current = this.player.commit?.files[this.player.state.file]?.path;
    if (!this.ide) {
      this.shell.print('fill: 에디터를 불러오는 중입니다. 잠시 뒤 다시 해 보세요.', 'muted');
      return;
    }
    this.ide.replaceAll(files, current);
    this.followedPath = '';
    this.shell.print(`fill: 파일 ${files.size}개를 ${key} 단계 커밋 ${this.player.commitIndex + 1} 직전 상태로 채웠습니다.`, 'ok');
  }

  private diff(): void {
    const guide = this.guide;
    const key = this.player.playlist?.key;
    const path = this.player.commit?.files[this.player.state.file]?.path ?? this.ide?.activePath;
    if (!guide || !key || !path || !this.ide) {
      this.shell.print('diff: 비교할 파일이 없습니다. 먼저 재생을 시작하세요.', 'error');
      return;
    }
    const expected = snapshotBefore(guide, key, this.player.commitIndex + 1).get(path) ?? '';
    this.openModal(`비교 · ${path}`, 'diff');
    this.ide.showDiff($('#modal-diff'), path, expected);
    this.shell.print(`diff: 왼쪽은 이 커밋이 끝난 모습, 오른쪽은 내 코드(편집 가능)입니다.`, 'muted');
  }

  private openModal(title: string, kind: 'doc' | 'diff'): void {
    $('#modal-title').textContent = title;
    $('#modal-doc').hidden = kind !== 'doc';
    $('#modal-diff').hidden = kind !== 'diff';
    $('#modal').hidden = false;
    this.player.pause();
  }

  private closeModal(): void {
    $('#modal').hidden = true;
    this.ide?.closeDiff();
  }

  // ---------------------------------------------------------------- shell host

  prompt(): string {
    return `guest@code-replay:~${this.guide ? `/${this.guide.slug}` : ''}$`;
  }

  complete(words: string[], index: number): string[] {
    const commands = ['help', 'keys', 'ls', 'cd', 'play', 'read', 'stages', 'branches', 'pause', 'resume', 'restart', 'next', 'prev', 'speed', 'notes', 'autopause', 'fill', 'diff', 'done', 'clear'];
    if (index === 0) return commands;
    const command = words[0];
    if (command === 'cd' || command === 'open') return ['..', ...this.guides.map((g) => g.slug)];
    if (command === 'notes' || command === 'autopause') return ['on', 'off'];
    if (command === 'play' || command === 'read' || command === 'done') {
      const stages = this.guide?.stages.map((s) => s.id) ?? [];
      const branches = this.guide?.branches.map((b) => b.name) ?? [];
      const extra = command === 'play' ? ['next', 'prev'] : command === 'read' ? ['intro'] : [];
      return [...stages, ...branches, ...extra];
    }
    return [];
  }

  run(command: string, args: string[]): void {
    const arg = args[0];
    switch (command) {
      case 'help':
      case '?':
        this.printTable(HELP);
        this.shell.printHtml('<span class="muted">단축키는</span> <a data-cmd="keys">keys</a>');
        break;
      case 'keys':
        this.printTable(KEYS);
        break;
      case 'ls':
        if (this.guide && arg !== '..' && arg !== '/') this.listStages();
        else this.listGuides();
        break;
      case 'cd':
      case 'open':
        location.hash = !arg || ['..', '~', '/'].includes(arg) ? '#/' : `#/${encodeURIComponent(arg.replace(/\/$/, ''))}`;
        break;
      case 'stages':
        if (this.requireGuide()) this.listStages();
        break;
      case 'branches':
        if (this.requireGuide()) this.listBranches();
        break;
      case 'play':
        if (this.requireGuide()) this.play(arg);
        break;
      case 'read':
        if (this.requireGuide()) this.read(arg);
        break;
      case 'pause':
        this.player.pause();
        break;
      case 'resume':
        this.player.play();
        break;
      case 'restart':
        this.player.restart();
        break;
      case 'next':
        this.player.next();
        break;
      case 'prev':
        this.player.prev();
        break;
      case 'speed':
        if (arg) {
          const ms = Number(arg);
          if (Number.isFinite(ms) && ms > 0) this.setSpeed(ms);
          else this.shell.print('speed: 숫자(ms)를 주세요. 예: speed 60', 'error');
        }
        this.shell.print(`타이핑 속도 ${this.player.speedMs}ms / 글자`, 'muted');
        break;
      case 'notes':
        this.notesOn = arg ? arg !== 'off' : !this.notesOn;
        storage.set('notes', this.notesOn);
        if (!this.notesOn) this.bubble.clear();
        this.shell.print(`말풍선 설명 ${this.notesOn ? '켬' : '끔'}`, 'muted');
        break;
      case 'autopause':
        this.autopause = arg ? arg !== 'off' : !this.autopause;
        storage.set('autopause', this.autopause);
        this.shell.print(`말풍선이 뜰 때 ${this.autopause ? '멈춤' : '멈추지 않음'}`, 'muted');
        break;
      case 'fill':
        this.fill();
        break;
      case 'diff':
        this.diff();
        break;
      case 'done':
        if (this.requireGuide()) this.toggleDone(arg);
        break;
      case 'clear':
        this.shell.clear();
        break;
      case 'cargo':
      case 'git':
      case 'vim':
      case 'nvim':
        this.shell.print(`${command}: 여기는 재생 전용 터미널입니다. 빌드와 실행은 내 터미널에서 하세요.`, 'muted');
        break;
      default:
        this.shell.print(`${command}: 명령을 찾을 수 없습니다. help 를 입력해 보세요.`, 'error');
    }
    this.dirty = true;
  }

  private setSpeed(ms: number): void {
    this.player.setSpeed(ms);
    storage.set('speed', this.player.speedMs);
  }

  private requireGuide(): boolean {
    if (this.guide) return true;
    this.shell.print('먼저 가이드를 여세요: ls 로 목록을 보고 cd <가이드>', 'error');
    return false;
  }

  private banner(): void {
    this.shell.printHtml(
      '<span class="accent">code-replay</span> <span class="muted">— 오른쪽 재생을 보면서 왼쪽 에디터에 따라 치세요. 설명은 말풍선으로 나옵니다.</span>',
    );
    this.shell.printHtml(
      '<span class="muted">명령어는 </span><a data-cmd="help">help</a><span class="muted">, 단축키는 </span><a data-cmd="keys">keys</a><span class="muted">. 에디터에서 치는 중에도 Alt+Space 로 재생을 멈추고 이어 갈 수 있습니다.</span>',
    );
  }

  private printTable(rows: Array<[string, string]>): void {
    const width = Math.max(...rows.map(([a]) => a.length));
    for (const [a, b] of rows) {
      this.shell.printHtml(`<span class="accent">${escapeHtml(a.padEnd(width + 2))}</span><span class="muted">${escapeHtml(b)}</span>`);
    }
  }

  private listGuides(): void {
    if (this.guides.length === 0) {
      this.shell.print('가이드가 없습니다.', 'muted');
      return;
    }
    for (const g of this.guides) {
      const done = progressStore.get(g.slug).size;
      this.shell.printHtml(
        `<a data-cmd="cd ${escapeHtml(g.slug)}">${escapeHtml(g.slug.padEnd(18))}</a>` +
          `<span>${escapeHtml(g.title)}</span> <span class="muted">· 단계 ${g.stageCount} · 커밋 ${g.commitCount}${done ? ` · 완료 ${done}` : ''}</span>`,
      );
    }
  }

  private listStages(): void {
    const guide = this.guide;
    if (!guide) return;
    const done = progressStore.get(guide.slug);
    for (const s of guide.stages) {
      const mark = done.has(s.id) ? '<span class="ok">✓</span>' : ' ';
      const current = s.id === this.player.playlist?.key ? ' current' : '';
      this.shell.printHtml(
        `${mark} <a class="stage-link${current}" data-cmd="play ${escapeHtml(s.id)}">${escapeHtml(s.id.padEnd(6))}</a>` +
          `<span>${escapeHtml(stageTitle(s.id, s.title))}</span> <span class="muted">· 커밋 ${s.commits.length}</span>`,
      );
    }
    if (guide.branches.length) this.shell.printHtml('<span class="muted">실험 브랜치는</span> <a data-cmd="branches">branches</a>');
  }

  private listBranches(): void {
    const guide = this.guide;
    if (!guide) return;
    if (guide.branches.length === 0) {
      this.shell.print('실험 브랜치가 없습니다.', 'muted');
      return;
    }
    for (const b of guide.branches) {
      this.shell.printHtml(
        `<a data-cmd="play ${escapeHtml(b.name)}">${escapeHtml(b.name.padEnd(14))}</a>` +
          `<span>${escapeHtml(b.title)}</span> <span class="muted">· ${escapeHtml(b.after)} 이후 · 커밋 ${b.commits.length}</span>`,
      );
    }
  }

  private play(arg: string | undefined): void {
    const guide = this.guide;
    if (!guide) return;
    const stages = guide.stages;
    const index = stages.findIndex((s) => s.id === this.player.playlist?.key);
    let key = arg;
    if (!arg) key = this.player.playlist?.key ?? stages[0]?.id;
    else if (arg === 'next') key = stages[index + 1]?.id;
    else if (arg === 'prev') key = stages[Math.max(index - 1, 0)]?.id;
    if (!key) {
      this.shell.print('더 이상 단계가 없습니다.', 'muted');
      return;
    }
    if (this.playStage(key)) {
      const p = this.player.playlist;
      if (p) this.shell.print(`▶ ${p.key} — ${p.title} (커밋 ${p.commits.length}개)`, 'accent');
      this.shell.blur();
    }
  }

  private read(arg: string | undefined): void {
    const guide = this.guide;
    if (!guide) return;
    if (arg === 'intro') {
      this.openModal(`${guide.title} — 소개`, 'doc');
      this.modalDoc.show(guide.intro || `# ${guide.title}\n\n${guide.summary}`);
      return;
    }
    const key = arg ?? this.player.playlist?.key ?? guide.stages[0]?.id;
    const playlist = key ? this.playlistFor(key) : null;
    if (!key || !playlist) {
      this.shell.print(`read: ${arg}: 그런 단계가 없습니다.`, 'error');
      return;
    }
    this.openModal(`${key} · ${playlist.title}`, 'doc');
    this.modalDoc.show(this.docFor(key) || '(설명이 없습니다)');
  }

  private toggleDone(arg: string | undefined): void {
    const guide = this.guide;
    const key = arg ?? this.player.playlist?.key;
    if (!guide || !key) return;
    const done = progressStore.get(guide.slug);
    if (done.has(key)) done.delete(key);
    else done.add(key);
    progressStore.set(guide.slug, done);
    this.shell.print(`${key}: ${done.has(key) ? '완료로 표시' : '완료 해제'}`, 'muted');
  }

  // ---------------------------------------------------------------- input

  private control(action: ControlAction): void {
    const p = this.player;
    const actions: Record<ControlAction, () => void> = {
      prev: () => p.prev(),
      changeBack: () => p.changeBack(),
      lineBack: () => p.lineBack(),
      toggle: () => (this.bubble.open && !p.playing && !p.ended ? this.continueFromBubble() : p.togglePlay()),
      lineForward: () => p.lineForward(),
      changeForward: () => p.changeForward(),
      next: () => p.next(),
      restart: () => p.restart(),
      slower: () => this.setSpeed(p.speedMs + (p.speedMs < 20 ? 5 : p.speedMs < 100 ? 10 : 50)),
      faster: () => this.setSpeed(p.speedMs - (p.speedMs <= 20 ? 5 : p.speedMs <= 100 ? 10 : 50)),
    };
    actions[action]();
  }

  /** Alt shortcuts work everywhere, including inside the editor */
  private onAltKey(event: KeyboardEvent): void {
    if (!event.altKey || event.ctrlKey || event.metaKey || !this.guide) return;
    const keys: Record<string, () => void> = {
      Space: () => this.control('toggle'),
      Comma: () => this.control('lineBack'),
      Period: () => this.control('lineForward'),
      BracketLeft: () => this.control('prev'),
      BracketRight: () => this.control('next'),
      Minus: () => this.control('slower'),
      Equal: () => this.control('faster'),
      Slash: () => this.shell.focus(),
    };
    const handler = keys[event.code];
    if (handler) {
      event.preventDefault();
      event.stopPropagation();
      handler();
    }
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !$('#modal').hidden) {
      this.closeModal();
      return;
    }
    if (this.shell.focused || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, .monaco-editor') || !$('#modal').hidden) return;
    const keys: Record<string, () => void> = {
      ' ': () => this.control('toggle'),
      Enter: () => this.bubble.confirm(),
      h: () => this.control('lineBack'),
      l: () => this.control('lineForward'),
      H: () => this.control('changeBack'),
      L: () => this.control('changeForward'),
      p: () => this.control('prev'),
      n: () => this.control('next'),
      r: () => this.control('restart'),
      '-': () => this.control('slower'),
      '+': () => this.control('faster'),
      '=': () => this.control('faster'),
      '[': () => this.guide && this.play('prev'),
      ']': () => this.guide && this.play('next'),
      '/': () => this.shell.focus(),
      ':': () => this.shell.focus(),
      '?': () => this.shell.exec('keys'),
    };
    const handler = keys[event.key];
    if (handler) {
      event.preventDefault();
      handler();
    }
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    const guide = this.guide;
    const p = this.player;
    $('#crumbs').textContent = guide
      ? `~/${guide.slug}${p.playlist ? ` · ${p.playlist.key} ${p.playlist.title}` : ''}`
      : '~';
    if (!guide) {
      this.renderHome();
      this.editor.clear();
      this.controls.render(p);
      $('#stage-list').innerHTML = '';
      return;
    }
    this.editor.render(p.state, p.commit, p.playing);
    this.controls.render(p);
    this.renderStages();
    const path = p.commit?.files[p.state.file]?.path ?? '';
    if (path && this.ide && path !== this.followedPath) {
      this.followedPath = path;
      this.ide.followFile(path);
    }
    this.setHash();
  }

  private renderHome(): void {
    const html = `
      <pre class="logo">  ___ ___  __| | ___       _ __ ___ _ __ | | __ _ _   _
 / __/ _ \\/ _\` |/ _ \\_____| '__/ _ \\ '_ \\| |/ _\` | | | |
| (_| (_) | (_| |  __/_____| | |  __/ |_) | | (_| | |_| |
 \\___\\___/ \\__,_|\\___|     |_|  \\___| .__/|_|\\__,_|\\__, |
                                    |_|            |___/</pre>
      <p class="home-lead">Craft 코딩 가이드의 완성 코드를 한 글자씩 재생합니다. 오른쪽 재생을 보며 왼쪽 에디터에 따라 치고, 설명은 말풍선으로 읽으세요.</p>
      <ul class="guide-list">${this.guides
        .map(
          (g) => `<li><button type="button" data-cmd="cd ${escapeHtml(g.slug)}">
            <span class="guide-slug">${escapeHtml(g.slug)}</span>
            <span class="guide-title">${escapeHtml(g.title)}</span>
            <span class="guide-summary">${escapeHtml(g.summary)}</span>
            <span class="guide-meta">단계 ${g.stageCount} · 커밋 ${g.commitCount}${progressStore.get(g.slug).size ? ` · 완료 ${progressStore.get(g.slug).size}` : ''}</span>
          </button></li>`,
        )
        .join('')}</ul>
      <div class="home-help markdown">${renderMarkdown(
        '**쓰는 법** — 가이드를 고르고 `play` 로 단계를 재생합니다. 말풍선이 뜨면 읽고 **계속**(Alt+Space). 놓치면 `Alt+,` 로 한 줄 되감기, 내 코드와 다르면 **비교**. 중간 단계부터 시작하면 **여기까지 채우기**로 앞 단계 파일을 채웁니다.',
      )}</div>`;
    const home = $('#home');
    if (home.dataset.html !== html) {
      home.dataset.html = html;
      home.innerHTML = html;
    }
  }

  private renderStages(): void {
    const guide = this.guide;
    if (!guide) return;
    const done = progressStore.get(guide.slug);
    const current = this.player.playlist?.key;
    const item = (key: string, label: string, title: string, extra = '') =>
      `<li class="${key === current ? 'current' : ''} ${done.has(key) ? 'done' : ''} ${extra}">
        <button type="button" data-play="${escapeHtml(key)}"><span class="stage-id">${escapeHtml(label)}</span><span class="stage-title">${escapeHtml(title)}</span></button></li>`;
    const html = [
      ...guide.stages.map((s) => item(s.id, s.id, stageTitle(s.id, s.title))),
      ...guide.branches.map((b) => item(b.name, '⑂', b.title, 'branch')),
    ].join('');
    const list = $('#stage-list');
    if (list.dataset.html !== html) {
      list.dataset.html = html;
      list.innerHTML = html;
    }
  }
}
