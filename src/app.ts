import { splitNotes, type StageNotes } from './notes';
import { Player, type Playlist } from './player';
import type { Guide, GuideSummary } from './types';
import { BubbleView } from './views/bubble';
import { ControlsView, type ControlAction } from './views/controls';
import { DocView, renderMarkdown } from './views/doc';
import { EditorView } from './views/editor';
import type { IdeView } from './views/ide';
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

const KEYS: Array<[string, string]> = [
  ['Alt+Space', '재생 / 일시정지, 말풍선 계속 (에디터에서 치는 중에도 됨)'],
  ['Alt+, · Alt+.', '한 줄 뒤로 / 앞으로'],
  ['Alt+[ · Alt+]', '이전 / 다음 커밋'],
  ['Alt+- · Alt+=', '느리게 / 빠르게'],
  ['Space', '재생 / 일시정지 (에디터 밖에서)'],
  ['h · l', '한 줄 뒤로 / 앞으로'],
  ['H · L', '변경 단위 뒤로 / 앞으로'],
  ['p · n', '이전 / 다음 커밋'],
  ['[ · ]', '이전 / 다음 단계'],
  ['r', '이 커밋 처음부터'],
  ['?', '이 목록'],
];

export class App {
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
  private notes: StageNotes = { byCommit: new Map(), end: '' };
  private notesOn = storage.get('notes', true);
  private autopause = storage.get('autopause', true);
  private followedPath = '';
  private toastTimer = 0;
  private dirty = true;

  constructor() {
    this.controls = new ControlsView(
      $('#controls'),
      (action) => this.control(action),
      (commit) => this.player.seekCommit(commit),
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
        this.playStage(item.dataset.play);
      }
    });
    $('#home').addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-slug]');
      if (item?.dataset.slug) location.hash = `#/${encodeURIComponent(item.dataset.slug)}`;
    });
    document.querySelectorAll<HTMLElement>('[data-open-doc]').forEach((button) =>
      button.addEventListener('click', () => this.read(button.dataset.openDoc === 'intro' ? 'intro' : undefined)),
    );
    $('#toggle-drawer').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
    $('#open-keys').addEventListener('click', () => this.showKeys());
    $('#modal-close').addEventListener('click', () => this.closeModal());
    $('#modal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) this.closeModal();
    });
    this.bindSettings();
    $('#ide-compare').addEventListener('click', () => this.diff());
    $('#ide-download').addEventListener('click', () => this.ide?.download());
    // Capture phase, so Alt shortcuts work even while typing in the editor
    document.addEventListener('keydown', (event) => this.onAltKey(event), true);
    document.addEventListener('keydown', (event) => this.onKey(event));
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (!target.closest('#settings, #open-settings')) $('#settings').hidden = true;
      if (!target.closest('#drawer, #toggle-drawer')) document.body.classList.remove('drawer-open');
    });
    window.addEventListener('hashchange', () => void this.route());
  }

  async start(): Promise<void> {
    try {
      const response = await fetch(`${BASE}data/index.json`, { cache: 'no-store' });
      this.guides = (await response.json()) as GuideSummary[];
    } catch {
      this.toast('세션 목록을 불러오지 못했습니다. code-replay 서버가 켜져 있는지 확인하세요.', 'error');
    }
    await this.route();
    const loop = (now: number) => {
      this.player.tick(now);
      if (this.dirty) {
        this.dirty = false;
        this.render();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private bindSettings(): void {
    $('#open-settings').addEventListener('click', () => {
      $('#settings').hidden = !$('#settings').hidden;
    });
    const bind = (id: string, value: boolean, apply: (on: boolean) => void) => {
      const input = $(id) as HTMLInputElement;
      input.checked = value;
      input.addEventListener('change', () => apply(input.checked));
    };
    bind('#set-notes', this.notesOn, (on) => {
      this.notesOn = on;
      storage.set('notes', on);
      if (!on) this.bubble.clear();
    });
    bind('#set-autopause', this.autopause, (on) => {
      this.autopause = on;
      storage.set('autopause', on);
    });
    bind('#ide-follow', storage.get('follow', true), (on) => {
      if (this.ide) this.ide.follow = on;
      storage.set('follow', on);
      this.followedPath = '';
      this.dirty = true;
    });
  }

  private toast(message: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast ${kind}`;
    toast.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, kind === 'error' ? 6000 : 3500);
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
    if (this.guide?.slug !== slug && !(await this.openGuide(slug))) {
      location.hash = '#/';
      return;
    }
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
      const response = await fetch(`${BASE}data/${encodeURIComponent(slug)}.json`, { cache: 'no-store' });
      if (!response.ok) return null;
      const guide = (await response.json()) as Guide;
      this.cache.set(slug, guide);
      return guide;
    } catch {
      return null;
    }
  }

  private async openGuide(slug: string): Promise<boolean> {
    const guide = this.guides.some((g) => g.slug === slug) ? await this.loadGuide(slug) : null;
    if (!guide) {
      this.toast(`"${slug}" 세션이 없습니다.`, 'error');
      return false;
    }
    this.guide = guide;
    document.body.classList.add('in-guide');
    void this.loadIde().then((ide) => {
      // The user may have left or switched guides while the editor was loading
      if (this.guide?.slug !== slug) return;
      ide.load(slug);
      this.followedPath = '';
      this.dirty = true;
      // The opening bubble was shown before the editor existed; offer filling now that we can compare
      if (this.player.commitIndex === 0 && this.player.step <= 1) this.commitStarted(0);
    });
    this.followedPath = '';
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
      this.toast(`"${key}" 단계가 없습니다.`, 'error');
      return false;
    }
    if (playlist.commits.length === 0) this.toast(`${key} 단계에는 재생할 코드가 없습니다. 설명을 읽어 보세요.`);
    this.notes = splitNotes(this.docFor(key), playlist.commits);
    this.bubble.clear();
    this.player.load(playlist, commit, autoplay && playlist.commits.length > 0);
    this.setHash();
    this.dirty = true;
    return true;
  }

  /** Moves to the previous or next stage */
  private stepStage(delta: number): void {
    const stages = this.guide?.stages ?? [];
    const index = stages.findIndex((s) => s.id === this.player.playlist?.key);
    const target = stages[index + delta];
    if (target) this.playStage(target.id);
  }

  // ---------------------------------------------------------------- narration

  private commitStarted(index: number): void {
    const key = this.player.playlist?.key;
    const missing = index === 0 ? this.missingEarlierFiles() : 0;
    const note = this.notesOn ? this.notes.byCommit.get(index) : undefined;
    if (!key || (!note && !missing)) {
      this.bubble.collapse();
      return;
    }
    const path = this.player.commit?.files[0]?.path ?? '';
    const title = index === 0 ? '이 단계에서 할 일' : `다음 파일 · ${path}`;
    const offer = missing
      ? `> 내 코드에 앞 단계까지의 파일 ${missing}개가 없거나 다릅니다. 이 단계부터 바로 따라 치려면 **앞 단계 코드 채우기**를 누르세요. 같은 이름 파일만 덮어쓰고 다른 파일은 그대로 둡니다.\n\n`
      : '';
    this.bubble.show(`${key}:${index}:${missing}`, title, offer + (note ?? ''), [
      { label: '계속 ▶ <kbd>Alt+Space</kbd>', primary: true, run: () => this.continueFromBubble() },
      ...(missing ? [{ label: '앞 단계 코드 채우기', run: () => this.fill() }] : []),
      { label: '접어 두고 재생', run: () => this.continueFromBubble() },
    ]);
    if (this.autopause && this.player.playing) this.player.pause();
  }

  /** How many files from earlier stages are absent from (or differ in) the user's code */
  private missingEarlierFiles(): number {
    const guide = this.guide;
    const key = this.player.playlist?.key;
    if (!guide || !key || !this.ide) return 0;
    const normalize = (text: string) => text.replace(/[ \t]+$/gm, '').trimEnd();
    let missing = 0;
    for (const [path, content] of snapshotBefore(guide, key, 0)) {
      const mine = this.ide.contentOf(path);
      if (mine === undefined || normalize(mine) !== normalize(content)) missing++;
    }
    return missing;
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
    const body = this.notes.end || '이 단계의 코드를 모두 재생했습니다.';
    const actions = [
      ...(next
        ? [
            {
              label: `다음 단계 ${escapeHtml(next.id)} ▶`,
              primary: true,
              run: () => this.playStage(next.id),
            },
          ]
        : []),
      { label: '이 단계 처음부터', run: () => this.playStage(key) },
      { label: '접기', run: () => this.bubble.collapse() },
    ];
    this.bubble.show(`${key}:end`, next ? '단계 마무리 — 확인해 볼 것' : '마지막 단계 끝 — 확인해 볼 것', body, actions);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- my code

  /** Writes the code of everything before the current commit into the user's files */
  private fill(): void {
    const guide = this.guide;
    const key = this.player.playlist?.key;
    if (!guide || !key || !this.ide) return;
    const files = snapshotBefore(guide, key, this.player.commitIndex);
    if (files.size === 0) {
      this.toast('채울 앞 단계 코드가 없습니다. 첫 커밋부터 따라 치면 됩니다.');
      return;
    }
    const current = this.player.commit?.files[this.player.state.file]?.path;
    this.ide.writeFiles(files, current);
    this.followedPath = '';
    this.toast(`앞 단계까지의 파일 ${files.size}개를 채웠습니다. 에디터에서 Cmd/Ctrl+Z 로 되돌릴 수 있습니다.`, 'ok');
    if (this.player.commitIndex === 0) this.commitStarted(0);
  }

  private diff(): void {
    const guide = this.guide;
    const key = this.player.playlist?.key;
    const path = this.player.commit?.files[this.player.state.file]?.path ?? this.ide?.activePath;
    if (!guide || !key || !path || !this.ide) {
      this.toast('비교할 파일이 없습니다. 먼저 재생을 시작하세요.');
      return;
    }
    const expected = snapshotBefore(guide, key, this.player.commitIndex + 1).get(path) ?? '';
    this.openModal(`비교 · ${path} — 왼쪽: 이 커밋이 끝난 모습 · 오른쪽: 내 코드 (편집 가능)`, 'diff');
    this.ide.showDiff($('#modal-diff'), path, expected);
  }

  private read(arg: 'intro' | undefined): void {
    const guide = this.guide;
    if (!guide) return;
    if (arg === 'intro') {
      this.openModal(`${guide.title} — 소개`, 'doc');
      this.modalDoc.show(guide.intro || `# ${guide.title}\n\n${guide.summary}`);
      return;
    }
    const key = this.player.playlist?.key ?? guide.stages[0]?.id;
    const playlist = key ? this.playlistFor(key) : null;
    if (!key || !playlist) return;
    this.openModal(`${key} · ${playlist.title}`, 'doc');
    this.modalDoc.show(this.docFor(key) || '(설명이 없습니다)');
  }

  private showKeys(): void {
    this.openModal('단축키', 'doc');
    const rows = KEYS.map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n');
    this.modalDoc.show(`| 키 | 동작 |\n| --- | --- |\n${rows}`);
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

  // ---------------------------------------------------------------- input

  private setSpeed(ms: number): void {
    this.player.setSpeed(ms);
    storage.set('speed', this.player.speedMs);
  }

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
    };
    const handler = keys[event.code];
    if (handler) {
      event.preventDefault();
      event.stopPropagation();
      handler();
    }
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (!$('#modal').hidden) this.closeModal();
      $('#settings').hidden = true;
      document.body.classList.remove('drawer-open');
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || !this.guide) return;
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
      '[': () => this.stepStage(-1),
      ']': () => this.stepStage(1),
      '?': () => this.showKeys(),
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
    $('#crumbs').textContent = guide ? `${guide.slug}${p.playlist ? ` · ${p.playlist.key} ${p.playlist.title}` : ''}` : '';
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
    const cards = this.guides
      .map((g) => {
        const done = progressStore.get(g.slug).size;
        return `<li><button type="button" data-slug="${escapeHtml(g.slug)}">
            <span class="guide-slug">${escapeHtml(g.slug)}</span>
            <span class="guide-title">${escapeHtml(g.title)}</span>
            <span class="guide-summary">${escapeHtml(g.summary)}</span>
            <span class="guide-meta">단계 ${g.stageCount} · 커밋 ${g.commitCount}${done ? ` · 완료 ${done}` : ''}</span>
          </button></li>`;
      })
      .join('');
    const empty = renderMarkdown(
      '세션이 없습니다. 터미널에서 세션 파일을 추가하세요.\n\n```bash\ncode-replay add ./my-guide.yaml\ncode-replay import ~/code-replay-src/roguelike\ncode-replay new my-guide\n```',
    );
    const html = `
      <pre class="logo">  ___ ___  __| | ___       _ __ ___ _ __ | | __ _ _   _
 / __/ _ \\/ _\` |/ _ \\_____| '__/ _ \\ '_ \\| |/ _\` | | | |
| (_| (_) | (_| |  __/_____| | |  __/ |_) | | (_| | |_| |
 \\___\\___/ \\__,_|\\___|     |_|  \\___| .__/|_|\\__,_|\\__, |
                                    |_|            |___/</pre>
      <p class="home-lead">가이드의 완성 코드를 한 글자씩 재생합니다. 오른쪽 재생을 보며 왼쪽 에디터에 따라 치고, 설명은 말풍선으로 읽으세요.</p>
      ${this.guides.length ? `<ul class="guide-list">${cards}</ul>` : `<div class="home-help markdown">${empty}</div>`}`;
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
