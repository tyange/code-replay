// Builds a session from a guide source folder: a git repo with `stage-<id>` tags plus Markdown
// explanations, described by guide.json (see code-replay-src/CONTRACT.md).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { validateSession } from './sessions.mjs';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Reads many `rev:path` blobs with one `git cat-file --batch`. Missing ones come back as '' */
function readBlobs(repo, specs) {
  if (specs.length === 0) return [];
  const out = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: `${specs.join('\n')}\n`,
    maxBuffer: 512 * 1024 * 1024,
  });
  const blobs = [];
  let pos = 0;
  for (let i = 0; i < specs.length; i++) {
    const eol = out.indexOf(10, pos);
    const header = out.subarray(pos, eol).toString('utf8');
    pos = eol + 1;
    if (header.endsWith(' missing')) {
      blobs.push('');
      continue;
    }
    const size = Number(header.split(' ')[2]);
    blobs.push(out.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return blobs;
}

function resolveRev(repo, rev) {
  return git(repo, 'rev-parse', `${rev}^{commit}`).trim();
}

/** One step per commit in `from..to` (or everything up to `to`), with whole-file contents */
function stepsBetween(repo, from, to, ignore) {
  const range = from ? `${from}..${to}` : to;
  const hashes = git(repo, 'rev-list', '--reverse', '--no-merges', range).split('\n').filter(Boolean);
  const steps = [];
  for (const hash of hashes) {
    const parent = git(repo, 'rev-list', '--parents', '-n', '1', hash).trim().split(' ')[1];
    const message = git(repo, 'show', '-s', '--format=%s', hash).trim();
    const nameStatus = parent
      ? git(repo, 'diff', '--name-status', '-M', parent, hash)
      : git(repo, 'diff-tree', '--root', '-r', '--name-status', '--no-commit-id', hash);
    const files = [];
    const specs = [];
    for (const line of nameStatus.split('\n').filter(Boolean)) {
      const [code, ...paths] = line.split('\t');
      const path = paths[paths.length - 1];
      if (ignore.includes(path)) continue;
      // A rename becomes "delete the old path" + "write the new one"
      if (code.startsWith('R')) files.push({ path: paths[0], delete: true });
      if (code.startsWith('D')) {
        files.push({ path, delete: true });
        continue;
      }
      files.push({ path, content: '' });
      specs.push(`${hash}:${path}`);
    }
    const blobs = readBlobs(repo, specs);
    let b = 0;
    for (const file of files) if (!file.delete) file.content = blobs[b++] ?? '';
    if (files.length > 0) steps.push({ message, files });
  }
  return steps;
}

function readDoc(base, rel) {
  if (!rel) return '';
  const path = join(base, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function importGuideFolder(base) {
  const meta = JSON.parse(readFileSync(join(base, 'guide.json'), 'utf8'));
  const repoPath = meta.repo ?? 'repo';
  const repo = isAbsolute(repoPath) ? repoPath : join(base, repoPath);
  const ignore = meta.ignore ?? [];

  let prev = null;
  const stages = meta.stages.map((stage) => {
    const tag = resolveRev(repo, stage.tag ?? `stage-${stage.id}`);
    const steps = stepsBetween(repo, prev, tag, ignore);
    prev = tag;
    return { id: String(stage.id), title: stage.title, doc: readDoc(base, stage.doc), steps };
  });

  const mainHead = resolveRev(repo, meta.main ?? 'main');
  const branches = (meta.branches ?? []).map((branch) => {
    const head = resolveRev(repo, branch.name);
    const forkPoint = git(repo, 'merge-base', mainHead, head).trim();
    return {
      name: branch.name,
      title: branch.title,
      after: String(branch.after),
      doc: readDoc(base, branch.doc),
      steps: stepsBetween(repo, forkPoint, head, ignore),
    };
  });

  return validateSession({
    slug: meta.slug,
    title: meta.title,
    summary: meta.summary ?? '',
    lang: meta.lang ?? 'rust',
    source: meta.source ?? '',
    intro: readDoc(base, meta.intro ?? 'intro.md'),
    publish: meta.publish,
    stages,
    branches,
  });
}
