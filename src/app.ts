import { Player, type Playlist } from './player';
import type { Guide, GuideSummary } from './types';
import { ControlsView, type ControlAction } from './views/controls';
import { DocView } from './views/doc';
import { EditorView } from './views/editor';
import { Shell, type ShellHost } from './views/shell';
import { TreeView } from './views/tree';

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

/** Per-viewer progress, kept only in this browser */
const progressStore = {
  key: (slug: string) => `code-replay:done:${slug}`,
  get(slug: string): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(this.key(slug)) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  },
  set(slug: string, done: Set<string>): void {
    try {
      localStorage.setItem(this.key(slug), JSON.stringify([...done]));
    } catch {
      // storage unavailable: progress just isn't remembered
    }
  },
};

const HELP: Array<[string, string]> = [
  ['ls', '가이드 목록 (가이드 안에서는 단계 목록)'],
  ['cd <가이드>', '가이드 열기 · cd .. 으로 나가기'],
  ['play [단계]', '단계 재생 · play next / play prev'],
  ['read [단계|intro]', '설명만 보기'],
  ['stages', '단계 목록과 진행 표시'],
  ['branches', '실험 브랜치 목록 · play <브랜치>'],
  ['pause · resume · restart', '재생 제어'],
  ['next · prev', '다음 / 이전 커밋'],
  ['speed [ms]', '타이핑 속도 (글자당 ms, 작을수록 빠름)'],
  ['done [단계]', '단계를 완료로 표시 / 해제'],
  ['clear', '화면 지우기 (Ctrl+L)'],
];

const KEYS: Array<[string, string]> = [
  ['Space', '재생 / 일시정지'],
  ['h · l', '한 줄 뒤로 / 앞으로'],
  ['H · L', '변경 단위 뒤로 / 앞으로'],
  ['p · n', '이전 / 다음 커밋'],
  ['[ · ]', '이전 / 다음 단계'],
  ['r', '이 커밋 처음부터'],
  ['- · +', '느리게 / 빠르게'],
  ['/ · :', '명령어 입력'],
];

export class App implements ShellHost {
  private guides: GuideSummary[] = [];
  private guide: Guide | null = null;
  private readonly cache = new Map<string, Guide>();
  private docMode: 'stage' | 'intro' = 'stage';
  private readonly player = new Player(DEFAULT_SPEED);
  private readonly editor = new EditorView($('#editor-title'), $('#editor'));
  private readonly tree = new TreeView($('#file-tree'));
  private readonly doc = new DocView($('#doc'));
  private readonly controls: ControlsView;
  private readonly shell: Shell;
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
    this.player.onEnd = () => this.stageEnded();

    $('#stage-list').addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-play]');
      if (item?.dataset.play) this.shell.exec(`play ${item.dataset.play}`);
    });
    $('#home').addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
      if (item?.dataset.cmd) this.shell.exec(item.dataset.cmd);
    });
    document.querySelectorAll<HTMLElement>('[data-doc]').forEach((tab) =>
      tab.addEventListener('click', () => {
        this.docMode = tab.dataset.doc === 'intro' ? 'intro' : 'stage';
        this.renderDoc();
      }),
    );
    $('#toggle-side').addEventListener('click', () => document.body.classList.toggle('side-open'));
    $('#toggle-shell').addEventListener('click', () => document.body.classList.toggle('shell-tall'));
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

  // ---------------------------------------------------------------- routing

  private async route(): Promise<void> {
    const [slug, stage, commit] = decodeURIComponent(location.hash.replace(/^#\/?/, ''))
      .split('/')
      .filter(Boolean);
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
    this.docMode = 'intro';
    this.shell.printHtml(
      `<b>${escapeHtml(guide.title)}</b> — ${escapeHtml(guide.summary)}<br>` +
        `<span class="muted">단계 ${guide.stages.length}개. </span><a data-cmd="play">play</a><span class="muted"> 로 첫 단계부터, </span><a data-cmd="stages">stages</a><span class="muted"> 로 목록을 봅니다.</span>`,
    );
    this.shell.updatePrompt();
    this.dirty = true;
    return true;
  }

  private leaveGuide(): void {
    this.guide = null;
    this.player.playlist = null;
    this.player.pause();
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
    return (
      guide.stages.find((s) => s.id === key)?.doc ??
      guide.branches.find((b) => b.name === key)?.doc ??
      ''
    );
  }

  private playStage(key: string, commit = 0, autoplay = true): boolean {
    const playlist = this.playlistFor(key);
    if (!playlist) {
      this.shell.print(`play: ${key}: 그런 단계가 없습니다. stages 로 목록을 보세요.`, 'error');
      return false;
    }
    if (playlist.commits.length === 0) {
      this.shell.print(`${key} 단계에는 재생할 커밋이 없습니다. 설명만 봅니다.`, 'muted');
    }
    this.player.load(playlist, commit, autoplay && playlist.commits.length > 0);
    this.docMode = 'stage';
    this.setHash();
    this.dirty = true;
    return true;
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
  }

  // ---------------------------------------------------------------- shell host

  prompt(): string {
    return `guest@code-replay:~${this.guide ? `/${this.guide.slug}` : ''}$`;
  }

  complete(words: string[], index: number): string[] {
    const commands = ['help', 'ls', 'cd', 'open', 'play', 'read', 'stages', 'branches', 'pause', 'resume', 'restart', 'next', 'prev', 'speed', 'done', 'clear', 'keys'];
    if (index === 0) return commands;
    const command = words[0];
    if (command === 'cd' || command === 'open') return ['..', ...this.guides.map((g) => g.slug)];
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
        this.help();
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
        if (!arg || arg === '..' || arg === '~' || arg === '/') {
          location.hash = '#/';
        } else {
          location.hash = `#/${encodeURIComponent(arg.replace(/\/$/, ''))}`;
        }
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
        if (!this.player.playing) this.player.togglePlay();
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
          if (Number.isFinite(ms) && ms > 0) this.player.setSpeed(ms);
          else this.shell.print('speed: 숫자(ms)를 주세요. 예: speed 60', 'error');
        }
        this.shell.print(`타이핑 속도 ${this.player.speedMs}ms / 글자`, 'muted');
        break;
      case 'done':
        if (this.requireGuide()) this.toggleDone(arg);
        break;
      case 'clear':
        this.shell.clear();
        break;
      case 'whoami':
        this.shell.print('guest — 따라 치는 사람', 'muted');
        break;
      case 'cargo':
      case 'git':
      case 'vim':
      case 'nvim':
        this.shell.print(`${command}: 여기는 재생 전용 터미널입니다. 내 터미널에서 실행하세요.`, 'muted');
        break;
      default:
        this.shell.print(`${command}: 명령을 찾을 수 없습니다. help 를 입력해 보세요.`, 'error');
    }
    this.dirty = true;
  }

  private requireGuide(): boolean {
    if (this.guide) return true;
    this.shell.print('먼저 가이드를 여세요: ls 로 목록을 보고 cd <가이드>', 'error');
    return false;
  }

  private banner(): void {
    this.shell.printHtml(
      '<span class="accent">code-replay</span> <span class="muted">— Craft 가이드의 코드를 타이핑 애니메이션으로 재생합니다. 보면서 내 에디터에 따라 치세요.</span>',
    );
    this.shell.printHtml(
      '<span class="muted">명령어는 </span><a data-cmd="help">help</a><span class="muted">, 단축키는 </span><a data-cmd="keys">keys</a><span class="muted">. Esc 로 입력창을 벗어나면 단축키가 동작합니다.</span>',
    );
  }

  private help(): void {
    this.printTable(HELP);
    this.shell.printHtml('<span class="muted">단축키는</span> <a data-cmd="keys">keys</a>');
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
    if (arg === 'intro') {
      this.docMode = 'intro';
    } else if (arg) {
      if (!this.playStage(arg, 0, false)) return;
    }
    if (arg !== 'intro') this.docMode = 'stage';
    this.renderDoc();
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
      toggle: () => p.togglePlay(),
      lineForward: () => p.lineForward(),
      changeForward: () => p.changeForward(),
      next: () => p.next(),
      restart: () => p.restart(),
      slower: () => p.changeSpeed(false),
      faster: () => p.changeSpeed(true),
    };
    actions[action]();
  }

  private onKey(event: KeyboardEvent): void {
    if (this.shell.focused || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select')) return;
    const keys: Record<string, () => void> = {
      ' ': () => this.control('toggle'),
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
      this.tree.render(null, -1);
      this.controls.render(p);
      $('#commit-info').innerHTML = '';
      $('#stage-list').innerHTML = '';
      return;
    }
    this.editor.render(p.state, p.commit, p.playing);
    this.tree.render(p.commit, p.state.file);
    this.controls.render(p);
    this.renderStages();
    this.renderCommitInfo();
    this.renderDoc();
    this.setHash();
  }

  private renderHome(): void {
    $('#home').innerHTML = `
      <pre class="logo">  ___ ___  __| | ___       _ __ ___ _ __ | | __ _ _   _
 / __/ _ \\/ _\` |/ _ \\_____| '__/ _ \\ '_ \\| |/ _\` | | | |
| (_| (_) | (_| |  __/_____| | |  __/ |_) | | (_| | |_| |
 \\___\\___/ \\__,_|\\___|     |_|  \\___| .__/|_|\\__,_|\\__, |
                                    |_|            |___/</pre>
      <p class="muted">가이드를 고르거나, 아래 터미널에 <code>cd &lt;가이드&gt;</code> 를 입력하세요.</p>
      <ul class="guide-list">${this.guides
        .map(
          (g) => `<li><button type="button" data-cmd="cd ${escapeHtml(g.slug)}">
            <span class="guide-slug">${escapeHtml(g.slug)}</span>
            <span class="guide-title">${escapeHtml(g.title)}</span>
            <span class="guide-summary">${escapeHtml(g.summary)}</span>
            <span class="guide-meta">단계 ${g.stageCount} · 커밋 ${g.commitCount}</span>
          </button></li>`,
        )
        .join('')}</ul>`;
    this.doc.show(
      `<h1>code-replay</h1>
      <p>Craft 에 정리해 둔 코딩 가이드를 단계별 완성 코드로 다시 쌓고, 그 커밋들을 타이핑 애니메이션으로 재생합니다.</p>
      <ol>
        <li>가이드를 열고 <code>play</code> 로 단계를 재생합니다.</li>
        <li>왼쪽 에디터에서 코드가 한 글자씩 쳐지는 걸 보며 내 에디터에 따라 칩니다.</li>
        <li>오른쪽에는 그 단계의 설명이 있습니다. 왜 이렇게 짜는지 먼저 읽어 두세요.</li>
        <li>놓치면 <kbd>Space</kbd> 로 멈추고 <kbd>h</kbd> 로 한 줄씩 되감습니다.</li>
      </ol>
      <p class="muted">완료한 단계는 이 브라우저에만 기억됩니다.</p>`,
      true,
    );
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
      ...guide.branches.map((b) => item(b.name, '⑂', `${b.title}`, 'branch')),
    ].join('');
    const list = $('#stage-list');
    if (list.dataset.html !== html) {
      list.dataset.html = html;
      list.innerHTML = html;
      list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
    }
  }

  private renderCommitInfo(): void {
    const c = this.player.commit;
    const info = $('#commit-info');
    if (!c) {
      info.innerHTML = '';
      return;
    }
    const files = c.files
      .map((f, i) => `<span class="${i === this.player.state.file ? 'current' : ''} status-${f.status}">${escapeHtml(f.path.split('/').pop() ?? f.path)}</span>`)
      .join(' ');
    const html = `<div><span class="label">commit</span> <span class="hash">${escapeHtml(c.hash)}</span></div>
      <div class="message">${escapeHtml(c.message)}</div>
      <div class="files">${files}</div>`;
    if (info.dataset.html !== html) {
      info.dataset.html = html;
      info.innerHTML = html;
    }
  }

  private renderDoc(): void {
    const guide = this.guide;
    if (!guide) return;
    document.querySelectorAll<HTMLElement>('[data-doc]').forEach((tab) =>
      tab.classList.toggle('active', tab.dataset.doc === this.docMode),
    );
    const source =
      this.docMode === 'intro'
        ? guide.intro || `# ${guide.title}\n\n${guide.summary}`
        : this.docFor(this.player.playlist?.key) || `# ${this.player.playlist?.title ?? ''}\n\n(설명이 없습니다)`;
    if (this.doc.show(source)) this.linkFileMarkers();
    this.highlightFileMarker();
  }

  /** "▶ `path` — 재생에서 따라 칩니다" lines jump to the commit that types that file */
  private linkFileMarkers(): void {
    const commits = this.player.playlist?.commits ?? [];
    const seen = new Map<string, number>();
    $('#doc')
      .querySelectorAll<HTMLElement>('p')
      .forEach((p) => {
        const code = p.querySelector('code');
        if (!p.textContent?.trimStart().startsWith('▶') || !code?.textContent) return;
        const path = code.textContent.trim();
        // The n-th marker for a file points at the n-th commit that touches it
        const nth = seen.get(path) ?? 0;
        seen.set(path, nth + 1);
        const matches = commits
          .map((c, i) => (c.files.some((f) => f.path === path || f.path.endsWith(`/${path}`)) ? i : -1))
          .filter((i) => i >= 0);
        const target = matches[Math.min(nth, matches.length - 1)];
        if (target === undefined) return;
        p.classList.add('file-jump');
        p.dataset.commit = String(target);
        p.title = `커밋 ${target + 1} 로 이동해 재생`;
        p.addEventListener('click', () => this.player.seekCommit(target));
      });
  }

  private highlightFileMarker(): void {
    const current = String(this.player.commitIndex);
    $('#doc')
      .querySelectorAll<HTMLElement>('p.file-jump')
      .forEach((p) => p.classList.toggle('playing', p.dataset.commit === current));
  }
}
