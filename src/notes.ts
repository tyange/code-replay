import type { Commit } from './types';

/** A stage's explanation cut into pieces that pop up while the stage plays */
export interface StageNotes {
  /** Text to show when the commit at this index starts */
  byCommit: Map<number, string>;
  /** What's left after the last file: checks, mistakes to try, questions */
  end: string;
}

const MARKER = /^▶\s*`([^`]+)`/;

function touches(commit: Commit, path: string): boolean {
  return commit.files.some((f) => f.path === path || f.path.endsWith(`/${path}`));
}

/**
 * Splits a stage's Markdown at its "▶ `path` — 재생에서 따라 칩니다" lines.
 * The text before a marker explains the file that comes next, so it is shown when
 * the commit typing that file starts. The n-th marker for a path is the n-th commit touching it.
 */
export function splitNotes(doc: string, commits: Commit[]): StageNotes {
  const byCommit = new Map<number, string>();
  const seen = new Map<string, number>();
  let buffer: string[] = [];
  let inFence = false;
  let first = true;

  const flush = (commit: number) => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;
    const previous = byCommit.get(commit);
    byCommit.set(commit, previous ? `${previous}\n\n${text}` : text);
  };

  for (const line of doc.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : MARKER.exec(line.trim());
    if (!match) {
      buffer.push(line);
      continue;
    }
    const path = match[1];
    const nth = seen.get(path) ?? 0;
    seen.set(path, nth + 1);
    const matches = commits.flatMap((c, i) => (touches(c, path) ? [i] : []));
    const target = matches[Math.min(nth, matches.length - 1)];
    if (target === undefined) continue;
    // The stage's opening text greets the first commit, whatever file it types
    flush(first ? 0 : target);
    first = false;
  }

  return { byCommit, end: buffer.join('\n').trim() };
}
