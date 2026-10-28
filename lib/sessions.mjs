// Learning sessions: one file per guide (YAML, JSON or TOML) that holds the stages, their
// explanations and the code at every step. The CLI and the static export both turn a session into
// the `Guide` JSON the web app plays (see src/types.ts).
//
// A session file looks like this (YAML shown; JSON and TOML use the same keys):
//
//   slug: roguelike
//   title: 로그라이크 직접 만들기
//   summary: 한두 문장
//   lang: rust
//   publish: false      # optional: leave out of the hosted build
//   intro: |            # Markdown shown under "소개"
//     ...
//   stages:
//     - id: "1-1"
//       title: 좌표와 타일 맵
//       doc: |          # Markdown; "▶ `path` — 재생에서 따라 칩니다" lines split it into speech bubbles
//         ...
//       steps:          # one step = one replayed commit
//         - message: "[1-1] geom.rs — 좌표와 방향"
//           file: rogue-core/src/geom.rs
//           content: |  # the whole file after this step
//             ...
//         - message: "[0] cargo new"
//           files:      # several files in one step; `delete: true` removes one
//             - { path: Cargo.toml, content: "..." }
//             - { path: old.rs, delete: true }
//   branches:           # optional experiments that start from the end of stage `after`
//     - name: exp/refs
//       title: 일부러 실패하기
//       after: "1-2"
//       doc: |
//       steps: [...]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const SESSION_EXTENSIONS = ['.yaml', '.yml', '.json', '.toml'];

export function isSessionFile(path) {
  return SESSION_EXTENSIONS.includes(extname(path).toLowerCase());
}

export function parseSession(text, path) {
  const ext = extname(path).toLowerCase();
  const data = ext === '.json' ? JSON.parse(text) : ext === '.toml' ? parseToml(text) : parseYaml(text);
  return validateSession(data, path);
}

export function readSession(path) {
  return parseSession(readFileSync(path, 'utf8'), path);
}

export function serializeSession(session, format = 'yaml') {
  if (format === 'json') return `${JSON.stringify(session, null, 2)}\n`;
  if (format === 'toml') return stringifyToml(session);
  return stringifyYaml(session, { lineWidth: 0, blockQuote: 'literal' });
}

export function writeSession(path, session) {
  const ext = extname(path).toLowerCase();
  const format = ext === '.json' ? 'json' : ext === '.toml' ? 'toml' : 'yaml';
  writeFileSync(path, serializeSession(session, format));
}

function fail(path, message) {
  throw new Error(`${basename(path)}: ${message}`);
}

/** Checks the shape and fills defaults, so the rest of the code can trust the session */
export function validateSession(data, path = 'session') {
  if (!data || typeof data !== 'object') fail(path, '세션 파일이 비어 있거나 객체가 아닙니다');
  const slug = String(data.slug ?? basename(path, extname(path)));
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) fail(path, `slug "${slug}" 는 영문, 숫자, - _ . 만 쓸 수 있습니다`);
  if (!Array.isArray(data.stages) || data.stages.length === 0) fail(path, 'stages 가 없습니다');

  const steps = (list, where) => {
    if (!Array.isArray(list)) fail(path, `${where}: steps 가 배열이 아닙니다`);
    return list.map((step, i) => {
      const files = step.files ?? (step.file !== undefined ? [{ path: step.file, content: step.content, delete: step.delete }] : null);
      if (!Array.isArray(files) || files.length === 0) fail(path, `${where} step ${i + 1}: file 또는 files 가 필요합니다`);
      return {
        message: String(step.message ?? files.map((f) => f.path).join(', ')),
        files: files.map((f, j) => {
          if (!f?.path) fail(path, `${where} step ${i + 1}: ${j + 1}번째 파일에 path 가 없습니다`);
          if (!f.delete && typeof f.content !== 'string') fail(path, `${where} step ${i + 1}: ${f.path} 의 content 가 없습니다`);
          return f.delete ? { path: String(f.path), delete: true } : { path: String(f.path), content: f.content };
        }),
      };
    });
  };

  const stageIds = new Set();
  const stages = data.stages.map((stage, i) => {
    const id = String(stage.id ?? i + 1);
    if (stageIds.has(id)) fail(path, `stage id "${id}" 가 두 번 나옵니다`);
    stageIds.add(id);
    return { id, title: String(stage.title ?? id), doc: String(stage.doc ?? ''), steps: steps(stage.steps ?? [], `stage ${id}`) };
  });
  const branches = (data.branches ?? []).map((branch) => {
    const after = String(branch.after ?? '');
    if (!stageIds.has(after)) fail(path, `branch ${branch.name}: after "${after}" 인 단계가 없습니다`);
    return {
      name: String(branch.name),
      title: String(branch.title ?? branch.name),
      after,
      doc: String(branch.doc ?? ''),
      steps: steps(branch.steps ?? [], `branch ${branch.name}`),
    };
  });

  return {
    slug,
    title: String(data.title ?? slug),
    summary: String(data.summary ?? ''),
    lang: String(data.lang ?? 'rust'),
    source: String(data.source ?? ''),
    intro: String(data.intro ?? ''),
    // `publish: false` keeps a session out of the static (hosted) build; the CLI still serves it
    ...(data.publish === false ? { publish: false } : {}),
    stages,
    branches,
  };
}

function shortHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 7);
}

/** Replays steps on top of `files` (a Map of path → content), producing the app's commits */
function toCommits(steps, files, salt) {
  return steps.map((step, i) => {
    const changes = step.files.map((f) => {
      const before = files.get(f.path);
      if (f.delete) {
        files.delete(f.path);
        return { path: f.path, status: 'D', before: before ?? '', after: '' };
      }
      files.set(f.path, f.content);
      return { path: f.path, status: before === undefined ? 'A' : 'M', before: before ?? '', after: f.content };
    });
    const hash = shortHash(`${salt}:${i}:${step.message}:${step.files.map((f) => `${f.path}\n${f.content ?? ''}`).join('\n')}`);
    return { hash, message: step.message, date: '', files: changes, tree: [...files.keys()].sort() };
  });
}

/** The `Guide` JSON the web app plays */
export function sessionToGuide(session) {
  const files = new Map();
  const after = new Map();
  const stages = session.stages.map((stage) => {
    const commits = toCommits(stage.steps, files, `${session.slug}/${stage.id}`);
    after.set(stage.id, new Map(files));
    return { id: stage.id, title: stage.title, doc: stage.doc, commits };
  });
  const branches = session.branches.map((branch) => ({
    name: branch.name,
    title: branch.title,
    after: branch.after,
    doc: branch.doc,
    commits: toCommits(branch.steps, new Map(after.get(branch.after)), `${session.slug}/${branch.name}`),
  }));
  return {
    slug: session.slug,
    title: session.title,
    lang: session.lang,
    summary: session.summary,
    source: session.source,
    intro: session.intro,
    stages,
    branches,
  };
}

export function guideSummary(guide) {
  return {
    slug: guide.slug,
    title: guide.title,
    lang: guide.lang,
    summary: guide.summary,
    stageCount: guide.stages.length,
    commitCount: guide.stages.reduce((n, s) => n + s.commits.length, 0),
  };
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Every session file in `dir`. A file that fails to parse is reported in `errors` instead of
 * breaking the others. Files starting with "_" are ignored (handy for drafts).
 */
export function loadSessions(dir) {
  const sessions = [];
  const errors = [];
  if (!existsSync(dir)) return { sessions, errors };
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('_') || name.startsWith('.') || !isSessionFile(name)) continue;
    const path = join(dir, name);
    try {
      sessions.push({ path, session: readSession(path) });
    } catch (error) {
      errors.push({ path, message: error.message });
    }
  }
  const seen = new Map();
  for (const { path, session } of sessions) {
    if (seen.has(session.slug)) errors.push({ path, message: `slug "${session.slug}" 가 ${basename(seen.get(session.slug))} 와 겹칩니다` });
    else seen.set(session.slug, path);
  }
  return { sessions: sessions.filter(({ path, session }) => seen.get(session.slug) === path), errors };
}
