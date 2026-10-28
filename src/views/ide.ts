import * as monaco from '../monaco';
import { workspaceStore, type Snapshot } from '../workspace';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  // A plain module worker; Vite bundles it in both dev and build
  getWorker: () =>
    new Worker(new URL('../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), {
      type: 'module',
    }),
};

monaco.editor.defineTheme('code-replay', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '565f89', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'bb9af7' },
    { token: 'string', foreground: '9ece6a' },
    { token: 'number', foreground: 'ff9e64' },
    { token: 'type', foreground: '7dcfff' },
    { token: 'type.identifier', foreground: '7dcfff' },
    { token: 'delimiter', foreground: '89ddff' },
    { token: 'operator', foreground: '89ddff' },
  ],
  colors: {
    'editor.background': '#16161e',
    'editor.foreground': '#c0caf5',
    'editor.lineHighlightBackground': '#24283b',
    'editorLineNumber.foreground': '#3b4261',
    'editorLineNumber.activeForeground': '#a9b1d6',
    'editorCursor.foreground': '#c0caf5',
    'editor.selectionBackground': '#364a82',
    'editorIndentGuide.background1': '#292e42',
    'editorWidget.background': '#1f2335',
    'diffEditor.insertedTextBackground': '#9ece6a26',
    'diffEditor.removedTextBackground': '#f7768e26',
  },
});

const LANGUAGES: Record<string, string> = {
  rs: 'rust',
  ron: 'rust',
  toml: 'ini',
  md: 'markdown',
  py: 'python',
  sh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  html: 'xml',
  xml: 'xml',
};

function languageOf(path: string): string {
  const ext = path.split('/').pop()?.split('.').slice(1).pop()?.toLowerCase() ?? '';
  return LANGUAGES[ext] ?? 'plaintext';
}

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'code-replay',
  automaticLayout: true,
  fontFamily: "'JetBrains Mono', 'Nanum Gothic Coding', ui-monospace, Menlo, monospace",
  fontSize: 14,
  lineHeight: 22,
  minimap: { enabled: false },
  scrollBeyondLastLine: true,
  tabSize: 4,
  insertSpaces: true,
  renderWhitespace: 'boundary',
  smoothScrolling: true,
  padding: { top: 8 },
  fixedOverflowWidgets: true,
};

/** The user's own editor: one Monaco instance, one model per file, saved in this browser */
export class IdeView {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private slug = '';
  private readonly models = new Map<string, monaco.editor.ITextModel>();
  private active = '';
  private saveTimer = 0;
  private diff: monaco.editor.IStandaloneDiffEditor | null = null;
  follow = true;

  /** Called when the set of files or the active file changes */
  onFilesChange: () => void = () => {};

  constructor(
    host: HTMLElement,
    private readonly tabs: HTMLElement,
  ) {
    this.editor = monaco.editor.create(host, { ...EDITOR_OPTIONS, model: null });
    this.tabs.addEventListener('click', (event) => {
      const tab = (event.target as HTMLElement).closest<HTMLElement>('[data-path]');
      if (tab?.dataset.path) this.open(tab.dataset.path, true);
    });
  }

  get activePath(): string {
    return this.active;
  }

  get paths(): string[] {
    return [...this.models.keys()].sort();
  }

  /** Switches to a guide's workspace, restoring what the user typed before */
  load(slug: string): void {
    if (slug === this.slug) return;
    this.saveNow();
    this.disposeModels();
    this.slug = slug;
    const saved = workspaceStore.load(slug);
    for (const [path, content] of Object.entries(saved.files)) this.createModel(path, content);
    const first = saved.active && this.models.has(saved.active) ? saved.active : this.paths[0];
    if (first) this.open(first);
    else this.editor.setModel(null);
    this.renderTabs();
  }

  unload(): void {
    this.saveNow();
    this.disposeModels();
    this.slug = '';
    this.editor.setModel(null);
    this.renderTabs();
  }

  /** Opens a file, creating it empty when it doesn't exist yet */
  open(path: string, focus = false): void {
    const model = this.models.get(path) ?? this.createModel(path, '');
    if (this.editor.getModel() !== model) this.editor.setModel(model);
    this.active = path;
    this.renderTabs();
    this.scheduleSave();
    if (focus) this.editor.focus();
  }

  /** Follows the replay to the file it is typing */
  followFile(path: string): void {
    if (this.follow && path && path !== this.active) this.open(path);
  }

  focus(): void {
    this.editor.focus();
  }

  contentOf(path: string): string | undefined {
    return this.models.get(path)?.getValue();
  }

  /** Writes the given files, overwriting same-named ones. Other files are left alone */
  writeFiles(files: Snapshot, activePath?: string): void {
    for (const [path, content] of files) {
      const model = this.models.get(path);
      if (!model) {
        this.createModel(path, content);
      } else if (model.getValue() !== content) {
        // pushEditOperations keeps this undoable
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
      }
    }
    const target = activePath && this.models.has(activePath) ? activePath : (this.active || this.paths[0]);
    if (target) this.open(target);
    this.saveNow();
    this.renderTabs();
  }

  download(path = this.active): void {
    const content = this.contentOf(path);
    if (content === undefined) return;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = path.split('/').pop() ?? 'file.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Side-by-side diff of the expected file (left) and the user's file (right) */
  showDiff(host: HTMLElement, path: string, expected: string): void {
    this.closeDiff();
    const mine = this.models.get(path) ?? this.createModel(path, '');
    this.diff = monaco.editor.createDiffEditor(host, {
      ...EDITOR_OPTIONS,
      renderSideBySide: host.clientWidth > 700,
      originalEditable: false,
      ignoreTrimWhitespace: true,
    });
    this.diff.setModel({ original: monaco.editor.createModel(expected, languageOf(path)), modified: mine });
  }

  closeDiff(): void {
    if (!this.diff) return;
    this.diff.getModel()?.original.dispose();
    this.diff.dispose();
    this.diff = null;
  }

  private createModel(path: string, content: string): monaco.editor.ITextModel {
    const uri = monaco.Uri.parse(`file:///${encodeURIComponent(this.slug)}/${path}`);
    monaco.editor.getModel(uri)?.dispose();
    const model = monaco.editor.createModel(content, languageOf(path), uri);
    model.onDidChangeContent(() => this.scheduleSave());
    this.models.set(path, model);
    this.renderTabs();
    return model;
  }

  private disposeModels(): void {
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.active = '';
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 400);
  }

  private saveNow(): void {
    window.clearTimeout(this.saveTimer);
    if (!this.slug) return;
    const files = Object.fromEntries([...this.models].map(([path, model]) => [path, model.getValue()]));
    workspaceStore.save(this.slug, files, this.active);
  }

  private renderTabs(): void {
    this.tabs.innerHTML = this.paths
      .map((path) => {
        const name = path.split('/').pop() ?? path;
        const current = path === this.active ? ' current' : '';
        return `<button type="button" class="ide-tab${current}" data-path="${escapeAttr(path)}" title="${escapeAttr(path)}">${escapeHtml(name)}</button>`;
      })
      .join('');
    this.tabs.querySelector('.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.onFilesChange();
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
