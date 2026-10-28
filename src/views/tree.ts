import type { Commit } from '../types';

interface Node {
  name: string;
  path: string;
  children: Map<string, Node>;
  file: boolean;
}

function build(paths: string[]): Node {
  const root: Node = { name: '', path: '', children: new Map(), file: false };
  for (const path of paths) {
    let node = root;
    const parts = path.split('/');
    parts.forEach((part, i) => {
      const childPath = parts.slice(0, i + 1).join('/');
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: childPath, children: new Map(), file: i === parts.length - 1 };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function sorted(node: Node): Node[] {
  return [...node.children.values()].sort((a, b) => {
    if (a.file !== b.file) return a.file ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** File tree of the current commit. Changed files are coloured, the file being typed is highlighted */
export class TreeView {
  constructor(private readonly root: HTMLElement) {}

  render(commit: Commit | null, currentFile: number): void {
    if (!commit) {
      this.root.innerHTML = '';
      return;
    }
    const status = new Map(commit.files.map((f) => [f.path, f.status] as const));
    const current = commit.files[currentFile]?.path;
    // Deleted files are no longer in the tree but should still show while being deleted
    const paths = [...new Set([...commit.tree, ...commit.files.map((f) => f.path)])];
    const rows: string[] = [];

    const walk = (node: Node, depth: number) => {
      for (const child of sorted(node)) {
        const indent = '  '.repeat(depth);
        if (child.file) {
          const s = status.get(child.path);
          const classes = ['tree-file'];
          if (s) classes.push(`status-${s}`);
          if (child.path === current) classes.push('current');
          const mark = s ? ` <span class="tree-mark">${s}</span>` : '';
          rows.push(`<div class="${classes.join(' ')}">${indent}${escape(child.name)}${mark}</div>`);
        } else {
          rows.push(`<div class="tree-dir">${indent}${escape(child.name)}/</div>`);
          walk(child, depth + 1);
        }
      }
    };
    walk(build(paths), 0);
    this.root.innerHTML = rows.join('');
    this.root.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
