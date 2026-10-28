import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { highlightBlock } from '../highlight';

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? '').split(/\s/)[0] || 'plaintext';
      return `<pre><code class="hljs">${highlightBlock(text, language)}</code></pre>`;
    },
  },
});

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, { ADD_TAGS: ['details', 'summary'] });
}

/** The explanation panel: renders a guide's Markdown */
export class DocView {
  private shown = '';

  constructor(private readonly root: HTMLElement) {}

  /** Returns true when the content was replaced */
  show(source: string, html = false): boolean {
    if (this.shown === source) return false;
    this.shown = source;
    this.root.innerHTML = html ? source : renderMarkdown(source);
    this.root.scrollTop = 0;
    return true;
  }
}
