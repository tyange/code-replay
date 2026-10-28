import type { EditorState } from '../engine';
import { highlightLines, languageFor } from '../highlight';
import type { Commit } from '../types';

/** Renders the file being typed, with line numbers, cursor and lines marked for deletion */
export class EditorView {
  private cache = { key: '', html: [] as string[] };

  constructor(
    private readonly title: HTMLElement,
    private readonly body: HTMLElement,
  ) {}

  clear(): void {
    this.title.textContent = '';
    this.body.innerHTML = '';
  }

  render(state: EditorState, commit: Commit | null, typing: boolean): void {
    const change = commit?.files[state.file];
    if (!change) {
      this.clear();
      return;
    }

    const status = { A: 'new', M: 'modified', D: 'deleted', R: 'renamed' }[change.status];
    this.title.innerHTML = '';
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = change.path;
    const badge = document.createElement('span');
    badge.className = `tab-status status-${change.status}`;
    badge.textContent = status;
    this.title.append(name, badge);

    const language = languageFor(change.path);
    const key = `${change.path}\n${state.lines.join('\n')}`;
    if (this.cache.key !== key) {
      this.cache = { key, html: highlightLines(state.lines, language) };
    }
    const html = this.cache.html;

    const width = String(Math.max(state.lines.length, 1)).length;
    const rows: string[] = [];
    const marked = state.marked;
    for (let i = 0; i < Math.max(state.lines.length, 1); i++) {
      const classes = ['line'];
      if (i === state.cursor.line) classes.push('cursor-line');
      if (marked && i >= marked.line && i < marked.line + marked.count) classes.push('marked');
      const number = String(i + 1).padStart(width, ' ');
      rows.push(
        `<div class="${classes.join(' ')}" data-line="${i}"><span class="ln">${number}</span><span class="code">${html[i] ?? ''}</span></div>`,
      );
    }
    this.body.innerHTML = rows.join('');

    const line = this.body.querySelector<HTMLElement>(`[data-line="${state.cursor.line}"] .code`);
    if (line) {
      insertCursor(line, state.cursor.col, typing);
      this.follow(line.parentElement as HTMLElement);
    }
  }

  /** Keeps the cursor line around the upper middle of the view */
  private follow(line: HTMLElement): void {
    const view = this.body;
    const top = line.offsetTop;
    const target = top - view.clientHeight * 0.4;
    if (top < view.scrollTop + 40 || top > view.scrollTop + view.clientHeight - 60) {
      view.scrollTop = Math.max(0, target);
    }
  }
}

/** Wraps the character at `col` of the rendered line in a cursor span */
function insertCursor(line: HTMLElement, col: number, typing: boolean): void {
  const cursor = document.createElement('span');
  cursor.className = typing ? 'cursor typing' : 'cursor';
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let remaining = col;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const length = node.data.length;
    if (remaining < length) {
      const rest = node.splitText(remaining);
      const ch = rest.data.slice(0, 1);
      // Keep surrogate pairs together
      const size = ch && /[\uD800-\uDBFF]/.test(ch) ? 2 : 1;
      rest.splitText(size);
      cursor.textContent = rest.data;
      rest.replaceWith(cursor);
      return;
    }
    remaining -= length;
  }
  cursor.textContent = ' ';
  line.append(cursor);
}
