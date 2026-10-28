import { applyFont, DEFAULT_FONT, FONTS, type FontSettings } from './fonts';
import { splitNotes, type StageNotes } from './notes';
import { Player, type Playlist } from './player';
import {
  applyTheme,
  AUTO_THEME,
  BUILTIN_THEMES,
  fromVsCodeTheme,
  systemTheme,
  type Theme,
  type VsCodeThemeJson,
} from './themes';
import type { Guide, GuideSummary } from './types';
import { BubbleView } from './views/bubble';
import { ControlsView, type ControlAction } from './views/controls';
import { DocView, renderMarkdown } from './views/doc';
import { EditorView } from './views/editor';

const DEFAULT_SPEED = 45;
const BASE = import.meta.env.BASE_URL;
const CUSTOM_FONT = '__custom__';

function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

function input(selector: string): HTMLInputElement {
  return $(selector) as HTMLInputElement;
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
  ['Space', '재생 / 일시정지, 말풍선 계속'],
  ['h · l', '한 줄 뒤로 / 앞으로'],
  ['H · L', '변경 단위 뒤로 / 앞으로'],
  ['p · n', '이전 / 다음 커밋'],
  ['[ · ]', '이전 / 다음 단계'],
  ['r', '이 커밋 처음부터'],
  ['- · +', '느리게 / 빠르게'],
  ['Alt + 위 키', '입력란에 커서가 있어도 동작 (Alt+Space, Alt+, Alt+. …)'],
  ['?', '이 목록'],
];

export class App {
  private guides: GuideSummary[] = [];
  private guide: Guide | null = null;
  private readonly cache = new Map<string, Guide>();
  private readonly player = new Player(storage.get('speed', DEFAULT_SPEED));
  private readonly editor = new EditorView($('#editor-title'), $('#editor'));
  private readonly bubble = new BubbleView($('#bubble'), $('#bubble-chip'));
  private readonly modalDoc = new DocView($('#modal-doc'));
  private readonly controls: ControlsView;
  private notes: StageNotes = { byCommit: new Map(), end: '' };
  private notesOn = storage.get('notes', true);
  private autopause = storage.get('autopause', true);
  private userThemes: Theme[] = [];
  private themeId = storage.get('theme', AUTO_THEME);
  private font = { ...DEFAULT_FONT, ...storage.get<Partial<FontSettings>>('font', {}) };
  private toastTimer = 0;
  private dirty = true;

  constructor() {
    this.applyTheme();
    applyFont(this.font);
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
    $('#open-settings').addEventListener('click', () => {
      $('#settings').hidden = !$('#settings').hidden;
    });
    $('#settings-close').addEventListener('click', () => {
      $('#settings').hidden = true;
    });
    $('#modal-close').addEventListener('click', () => this.closeModal());
    $('#modal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) this.closeModal();
    });
    this.bindSettings();
    // Capture phase, so Alt shortcuts work even while a text field has focus
    document.addEventListener('keydown', (event) => this.onAltKey(event), true);
    document.addEventListener('keydown', (event) => this.onKey(event));
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (!target.closest('#settings, #open-settings')) $('#settings').hidden = true;
      if (!target.closest('#drawer, #toggle-drawer')) document.body.classList.remove('drawer-open');
    });
    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => this.applyTheme());
    window.addEventListener('hashchange', () => void this.route());
  }

  async start(): Promise<void> {
    await this.loadUserThemes();
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

  // ---------------------------------------------------------------- appearance

  /** Theme files the CLI found in ~/.code-replay/themes (absent on a static build) */
  private async loadUserThemes(): Promise<void> {
    try {
      const response = await fetch(`${BASE}data/themes.json`, { cache: 'no-store' });
      if (response.ok) {
        const files = (await response.json()) as Array<{ id: string; theme: VsCodeThemeJson }>;
        this.userThemes = files.map(({ id, theme }) => fromVsCodeTheme(`file:${id}`, theme));
      }
    } catch {
      // no user themes
    }
    this.fillThemeSelect();
    this.applyTheme();
  }

  private currentTheme(): Theme {
    if (this.themeId === AUTO_THEME) return systemTheme();
    return [...BUILTIN_THEMES, ...this.userThemes].find((t) => t.id === this.themeId) ?? systemTheme();
  }

  private applyTheme(): void {
    applyTheme(this.currentTheme());
  }

  private fillThemeSelect(): void {
    const option = (t: Theme) =>
      `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}${t.kind === 'light' ? ' · 밝음' : ''}</option>`;
    const select = $('#set-theme') as HTMLSelectElement;
    select.innerHTML =
      `<option value="${AUTO_THEME}">자동 (시스템 밝기에 따라 Dark+ / Light+)</option>` +
      `<optgroup label="기본 제공">${BUILTIN_THEMES.map(option).join('')}</optgroup>` +
      (this.userThemes.length ? `<optgroup label="내 테마 (~/.code-replay/themes)">${this.userThemes.map(option).join('')}</optgroup>` : '');
    select.value = [AUTO_THEME, ...BUILTIN_THEMES.map((t) => t.id), ...this.userThemes.map((t) => t.id)].includes(this.themeId)
      ? this.themeId
      : AUTO_THEME;
  }

  private bindSettings(): void {
    const themeSelect = $('#set-theme') as HTMLSelectElement;
    themeSelect.addEventListener('change', () => {
      this.themeId = themeSelect.value;
      storage.set('theme', this.themeId);
      this.applyTheme();
    });

    const fontSelect = $('#set-font') as HTMLSelectElement;
    const custom = input('#set-font-custom');
    fontSelect.innerHTML =
      `<optgroup label="바로 받아 쓰기 (Google Fonts)">${FONTS.filter((f) => f.google)
        .map((f) => `<option>${escapeHtml(f.name)}</option>`)
        .join('')}</optgroup>` +
      `<optgroup label="설치되어 있으면">${FONTS.filter((f) => !f.google)
        .map((f) => `<option>${escapeHtml(f.name)}</option>`)
        .join('')}</optgroup>` +
      `<option value="${CUSTOM_FONT}">직접 입력…</option>`;
    const known = FONTS.some((f) => f.name === this.font.family);
    fontSelect.value = known ? this.font.family : CUSTOM_FONT;
    custom.value = known ? '' : this.font.family;
    custom.hidden = known;

    const size = input('#set-size');
    const line = input('#set-line');
    const ligatures = input('#set-ligatures');
    size.value = String(this.font.size);
    line.value = String(this.font.lineHeight);
    ligatures.checked = this.font.ligatures;

    const update = () => {
      const family = fontSelect.value === CUSTOM_FONT ? custom.value.trim() || DEFAULT_FONT.family : fontSelect.value;
      custom.hidden = fontSelect.value !== CUSTOM_FONT;
      this.font = { family, size: Number(size.value), lineHeight: Number(line.value), ligatures: ligatures.checked };
      $('#out-size').textContent = `${this.font.size}px`;
      $('#out-line').textContent = this.font.lineHeight.toFixed(2);
      applyFont(this.font);
      storage.set('font', this.font);
      this.dirty = true;
    };
    fontSelect.addEventListener('change', () => {
      update();
      if (fontSelect.value === CUSTOM_FONT) custom.focus();
    });
    for (const el of [custom, size, line, ligatures]) el.addEventListener('input', update);
    $('#out-size').textContent = `${this.font.size}px`;
    $('#out-line').textContent = this.font.lineHeight.toFixed(2);

    const notes = input('#set-notes');
    notes.checked = this.notesOn;
    notes.addEventListener('change', () => {
      this.notesOn = notes.checked;
      storage.set('notes', this.notesOn);
      if (!this.notesOn) this.bubble.clear();
    });
    const autopause = input('#set-autopause');
    autopause.checked = this.autopause;
    autopause.addEventListener('change', () => {
      this.autopause = autopause.checked;
      storage.set('autopause', this.autopause);
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
    this.dirty = true;
    return true;
  }

  private leaveGuide(): void {
    this.guide = null;
    this.player.playlist = null;
    this.player.pause();
    this.bubble.clear();
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
    const note = this.notesOn ? this.notes.byCommit.get(index) : undefined;
    if (!key || !note) {
      this.bubble.collapse();
      return;
    }
    const path = this.player.commit?.files[0]?.path ?? '';
    const title = index === 0 ? '이 단계에서 할 일' : `다음 파일 · ${path}`;
    this.bubble.show(`${key}:${index}`, title, note, [
      { label: '계속 ▶ <kbd>Space</kbd>', primary: true, run: () => this.continueFromBubble() },
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
    const body = this.notes.end || '이 단계의 코드를 모두 재생했습니다.';
    const actions = [
      ...(next ? [{ label: `다음 단계 ${escapeHtml(next.id)} ▶`, primary: true, run: () => this.playStage(next.id) }] : []),
      { label: '이 단계 처음부터', run: () => this.playStage(key) },
      { label: '접기', run: () => this.bubble.collapse() },
    ];
    this.bubble.show(`${key}:end`, next ? '단계 마무리 — 확인해 볼 것' : '마지막 단계 끝 — 확인해 볼 것', body, actions);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- documents

  private read(arg: 'intro' | undefined): void {
    const guide = this.guide;
    if (!guide) return;
    if (arg === 'intro') {
      this.openModal(`${guide.title} — 소개`);
      this.modalDoc.show(guide.intro || `# ${guide.title}\n\n${guide.summary}`);
      return;
    }
    const key = this.player.playlist?.key ?? guide.stages[0]?.id;
    const playlist = key ? this.playlistFor(key) : null;
    if (!key || !playlist) return;
    this.openModal(`${key} · ${playlist.title}`);
    this.modalDoc.show(this.docFor(key) || '(설명이 없습니다)');
  }

  private showKeys(): void {
    this.openModal('단축키');
    const rows = KEYS.map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n');
    this.modalDoc.show(`| 키 | 동작 |\n| --- | --- |\n${rows}`);
  }

  private openModal(title: string): void {
    $('#modal-title').textContent = title;
    $('#modal').hidden = false;
    $('#settings').hidden = true;
    this.player.pause();
  }

  private closeModal(): void {
    $('#modal').hidden = true;
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

  /** Alt shortcuts work even while a text field has focus */
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
      this.closeModal();
      $('#settings').hidden = true;
      document.body.classList.remove('drawer-open');
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select') || !$('#modal').hidden) return;
    if (event.key === '?') {
      event.preventDefault();
      this.showKeys();
      return;
    }
    if (!this.guide) return;
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
      <p class="home-lead">가이드의 완성 코드를 한 글자씩 재생합니다. VS Code 옆 탭에 띄워 두고 내 에디터에서 따라 치세요. 설명은 말풍선으로 나옵니다.</p>
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
