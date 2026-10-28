import { describe, expect, it } from 'vitest';
import { buildPlan, splitLines, stateAt, stopAfter, stopBefore } from './engine';
import type { Commit, FileChange } from './types';

function commit(...files: FileChange[]): Commit {
  return { hash: 'abc', message: 'm', date: '', files, tree: files.map((f) => f.path) };
}

function modified(before: string, after: string): FileChange {
  return { path: 'src/lib.rs', status: 'M', before, after };
}

describe('buildPlan', () => {
  it('replaying every step turns `before` into `after`', () => {
    const cases: Array<[string, string]> = [
      ['', 'fn main() {\n    println!("hi");\n}\n'],
      ['a\nb\nc\n', 'a\nB\nc\nd\n'],
      ['x\ny\nz\n', ''],
      ['keep\n', 'new\nkeep\n'],
      ['    indented\n', '    indented\n        한글 주석 // 유니코드\n'],
    ];
    for (const [before, after] of cases) {
      const c = commit(modified(before, after));
      const plan = buildPlan(c);
      const end = stateAt(plan, c, plan.steps.length);
      expect(end.lines).toEqual(splitLines(after));
    }
  });

  it('handles several files and resets the buffer per file', () => {
    const c = commit(
      { path: 'a.rs', status: 'A', before: '', after: 'one\n' },
      { path: 'b.rs', status: 'M', before: 'two\n', after: 'two\nthree\n' },
    );
    const plan = buildPlan(c);
    const atSecondFile = stateAt(plan, c, plan.fileStarts[1] + 1);
    expect(atSecondFile.file).toBe(1);
    expect(atSecondFile.lines).toEqual(['two']);
    expect(stateAt(plan, c, plan.steps.length).lines).toEqual(['two', 'three']);
  });

  it('marks line and change stops for stepping', () => {
    const c = commit(modified('a\nb\nc\n', 'a\nX\nc\nY\n'));
    const plan = buildPlan(c);
    // one hunk replaces b with X, another appends Y
    expect(plan.changeStops).toHaveLength(2);
    // delete b, type X, type Y
    expect(plan.lineStops).toHaveLength(3);
    const afterFirstLine = stateAt(plan, c, plan.lineStops[1]);
    expect(afterFirstLine.lines).toEqual(['a', 'c']);
  });
});

describe('stops', () => {
  it('finds the neighbouring stops', () => {
    const stops = [3, 8, 15];
    expect(stopBefore(stops, 8)).toBe(3);
    expect(stopBefore(stops, 9)).toBe(8);
    expect(stopBefore(stops, 2)).toBe(0);
    expect(stopAfter(stops, 8, 20)).toBe(15);
    expect(stopAfter(stops, 15, 20)).toBe(20);
  });
});
