import { describe, expect, it } from 'vitest';
import { parseSession, serializeSession, sessionToGuide, validateSession } from './sessions.mjs';

const yaml = `
slug: demo
title: 데모
stages:
  - id: "0"
    title: 시작
    doc: |
      # 시작
      ▶ \`src/lib.rs\` — 재생에서 따라 칩니다
    steps:
      - message: "[0] cargo new"
        files:
          - path: Cargo.toml
            content: |
              [package]
              name = "demo"
          - path: src/lib.rs
            content: ""
      - message: "[0] lib.rs"
        file: src/lib.rs
        content: |
          pub fn hi() {}
  - id: "1"
    steps:
      - file: src/lib.rs
        content: |
          pub fn hi() {}
          pub fn bye() {}
      - file: Cargo.toml
        delete: true
branches:
  - name: exp/a
    after: "0"
    steps:
      - file: src/lib.rs
        content: |
          broken(
`;

describe('sessions', () => {
  it('turns steps into commits with before/after and status', () => {
    const guide = sessionToGuide(parseSession(yaml, 'demo.yaml'));
    const [first, second] = guide.stages[0].commits;
    expect(first.files.map((f) => f.status)).toEqual(['A', 'A']);
    expect(second.files[0]).toMatchObject({ status: 'M', before: '', after: 'pub fn hi() {}\n' });
    const [grow, remove] = guide.stages[1].commits;
    expect(grow.files[0].before).toBe('pub fn hi() {}\n');
    expect(remove.files[0]).toMatchObject({ status: 'D', after: '' });
    expect(remove.tree).toEqual(['src/lib.rs']);
  });

  it('starts branches from the end of their stage', () => {
    const guide = sessionToGuide(parseSession(yaml, 'demo.yaml'));
    const branch = guide.branches[0].commits[0];
    expect(branch.files[0].before).toBe('pub fn hi() {}\n');
    expect(branch.tree).toEqual(['Cargo.toml', 'src/lib.rs']);
  });

  it('round-trips through YAML, JSON and TOML', () => {
    const session = parseSession(yaml, 'demo.yaml');
    for (const format of ['yaml', 'json', 'toml']) {
      const again = parseSession(serializeSession(session, format), `demo.${format}`);
      expect(sessionToGuide(again)).toEqual(sessionToGuide(session));
    }
  });

  it('reports what is wrong', () => {
    expect(() => validateSession({ stages: [] }, 'x.yaml')).toThrow(/stages/);
    expect(() => validateSession({ stages: [{ id: '1', steps: [{ file: 'a.rs' }] }] }, 'x.yaml')).toThrow(/content/);
    expect(() => validateSession({ stages: [{ id: '1' }], branches: [{ name: 'b', after: '9' }] }, 'x.yaml')).toThrow(/after/);
  });
});
