import { describe, expect, it } from 'vitest';
import { splitNotes } from './notes';
import type { Commit } from './types';

function commit(...paths: string[]): Commit {
  return {
    hash: 'h',
    message: 'm',
    date: '',
    files: paths.map((path) => ({ path, status: 'M' as const, before: '', after: '' })),
    tree: paths,
  };
}

describe('splitNotes', () => {
  const commits = [commit('Cargo.toml'), commit('src/geom.rs'), commit('src/map.rs'), commit('src/geom.rs')];

  it('attaches the text before each marker to the commit that types the file', () => {
    const doc = [
      '# 1-1. 좌표',
      '만들 것',
      '▶ `src/geom.rs` — 재생에서 따라 칩니다',
      '맵 설명',
      '▶ `src/map.rs` — 재생에서 따라 칩니다',
      'geom 을 다시 고친다',
      '▶ `src/geom.rs` — 재생에서 따라 칩니다',
      '### 확인',
      '테스트 4개',
    ].join('\n');
    const notes = splitNotes(doc, commits);
    expect(notes.byCommit.get(0)).toBe('# 1-1. 좌표\n만들 것');
    expect(notes.byCommit.get(2)).toBe('맵 설명');
    expect(notes.byCommit.get(3)).toBe('geom 을 다시 고친다');
    expect(notes.end).toBe('### 확인\n테스트 4개');
  });

  it('ignores markers inside code blocks and markers for unknown files', () => {
    const doc = ['intro', '```', '▶ `src/geom.rs`', '```', '▶ `nope.rs` — x', 'more', '▶ `map.rs` — x', 'end'].join('\n');
    const notes = splitNotes(doc, commits);
    expect(notes.byCommit.get(0)).toBe('intro\n```\n▶ `src/geom.rs`\n```\nmore');
    expect(notes.end).toBe('end');
  });
});
