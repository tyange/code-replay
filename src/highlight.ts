import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import ini from 'highlight.js/lib/languages/ini';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerAliases(['toml'], { languageName: 'ini' });
hljs.registerAliases(['sh', 'shell', 'console'], { languageName: 'bash' });
hljs.registerAliases(['rs', 'ron'], { languageName: 'rust' });
hljs.registerAliases(['html'], { languageName: 'xml' });
hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });

const BY_EXTENSION: Record<string, string> = {
  rs: 'rust',
  ron: 'rust',
  toml: 'ini',
  lock: 'ini',
  json: 'json',
  md: 'markdown',
  py: 'python',
  sh: 'bash',
  sql: 'sql',
  html: 'xml',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
};

export function languageFor(path: string): string {
  const name = path.split('/').pop() ?? '';
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  return BY_EXTENSION[ext] ?? 'plaintext';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Highlighted HTML split into lines. Spans that cross a newline are closed and reopened */
export function highlightLines(lines: string[], language: string): string[] {
  const source = lines.join('\n');
  let html: string;
  try {
    html = hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch {
    html = escapeHtml(source);
  }

  const out: string[] = [];
  const open: string[] = [];
  let current = '';
  const tag = /<span[^>]*>|<\/span>|\n|[^<\n]+/g;
  for (const match of html.matchAll(tag)) {
    const token = match[0];
    if (token === '\n') {
      out.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else if (token.startsWith('<span')) {
      open.push(token);
      current += token;
    } else if (token === '</span>') {
      open.pop();
      current += token;
    } else {
      current += token;
    }
  }
  out.push(current + '</span>'.repeat(open.length));
  while (out.length < lines.length) out.push('');
  return out.slice(0, lines.length);
}

export function highlightBlock(code: string, language: string): string {
  const lang = hljs.getLanguage(language) ? language : 'plaintext';
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
