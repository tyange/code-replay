// Turns guide sources (a git repo with stage tags + Markdown explanations) into the JSON the app plays.
//
//   node scripts/export.mjs [source dir]   (default ../code-replay-src)
//
// Each <source>/<slug>/guide.json is described in code-replay-src/CONTRACT.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(process.argv[2] ?? join(root, '..', 'code-replay-src'));
const outDir = join(root, 'public', 'data');


function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

const NO_BLOB = 'f'.repeat(40);

/** Reads many `rev:path` blobs with one `git cat-file --batch`. Missing ones come back as '' */
function readBlobs(repo, specs) {
  if (specs.length === 0) return [];
  const out = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: specs.join('\n') + '\n',
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

function exportCommit(repo, hash, ignore) {
  const parents = git(repo, 'rev-list', '--parents', '-n', '1', hash).trim().split(' ').slice(1);
  const parent = parents[0];
  const raw = git(repo, 'show', '-s', '--format=%s%x00%aI', hash).trim();
  const [message, date] = raw.split('\0');
  const nameStatus = parent
    ? git(repo, 'diff', '--name-status', '-M', parent, hash)
    : git(repo, 'diff-tree', '--root', '-r', '--name-status', '--no-commit-id', hash);

  const files = [];
  const specs = [];
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [code, ...paths] = line.split('\t');
    const status = code[0];
    const path = paths[paths.length - 1];
    const oldPath = status === 'R' ? paths[0] : path;
    if (ignore.includes(path)) continue;
    files.push({
      path,
      status: ['A', 'M', 'D', 'R'].includes(status) ? status : 'M',
      ...(status === 'R' ? { oldPath } : {}),
      before: '',
      after: '',
    });
    // Unreadable specs (no parent, deleted file) come back as ''
    specs.push(status === 'A' || !parent ? NO_BLOB : `${parent}:${oldPath}`);
    specs.push(status === 'D' ? NO_BLOB : `${hash}:${path}`);
  }
  const blobs = readBlobs(repo, specs);
  files.forEach((file, i) => {
    file.before = blobs[i * 2];
    file.after = blobs[i * 2 + 1];
  });

  const tree = git(repo, 'ls-tree', '-r', '--name-only', hash)
    .split('\n')
    .filter((p) => p && !ignore.includes(p));
  return { hash: hash.slice(0, 7), message, date, files, tree };
}

function commitsBetween(repo, from, to, ignore) {
  const range = from ? `${from}..${to}` : to;
  return git(repo, 'rev-list', '--reverse', '--no-merges', range)
    .split('\n')
    .filter(Boolean)
    .map((hash) => exportCommit(repo, hash, ignore))
    .filter((c) => c.files.length > 0);
}

function readDoc(base, rel) {
  if (!rel) return '';
  const path = join(base, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function exportGuide(base) {
  const meta = JSON.parse(readFileSync(join(base, 'guide.json'), 'utf8'));
  const repoPath = meta.repo ?? 'repo';
  const repo = isAbsolute(repoPath) ? repoPath : join(base, repoPath);
  // Files that belong to the replay tooling rather than the guide can be listed in guide.json
  const ignore = meta.ignore ?? [];

  let prev = null;
  const stages = meta.stages.map((stage) => {
    const tag = resolveRev(repo, stage.tag ?? `stage-${stage.id}`);
    const commits = commitsBetween(repo, prev, tag, ignore);
    prev = tag;
    return { id: stage.id, title: stage.title, doc: readDoc(base, stage.doc), commits };
  });

  const branches = (meta.branches ?? []).map((branch) => {
    const head = resolveRev(repo, branch.name);
    const mainHead = resolveRev(repo, meta.main ?? 'main');
    const forkPoint = git(repo, 'merge-base', mainHead, head).trim();
    return {
      name: branch.name,
      title: branch.title,
      after: branch.after,
      doc: readDoc(base, branch.doc),
      commits: commitsBetween(repo, forkPoint, head, ignore),
    };
  });

  return {
    slug: meta.slug,
    title: meta.title,
    lang: meta.lang ?? 'rust',
    summary: meta.summary ?? '',
    source: meta.source ?? '',
    intro: readDoc(base, meta.intro ?? 'intro.md'),
    stages,
    branches,
  };
}

mkdirSync(outDir, { recursive: true });
const order = existsSync(join(sourceDir, 'order.json'))
  ? JSON.parse(readFileSync(join(sourceDir, 'order.json'), 'utf8'))
  : [];
const slugs = readdirSync(sourceDir)
  .filter((name) => statSync(join(sourceDir, name)).isDirectory())
  .filter((name) => existsSync(join(sourceDir, name, 'guide.json')))
  .sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  });

const index = [];
for (const slug of slugs) {
  try {
    const guide = exportGuide(join(sourceDir, slug));
    writeFileSync(join(outDir, `${guide.slug}.json`), JSON.stringify(guide));
    const commitCount = guide.stages.reduce((n, s) => n + s.commits.length, 0);
    index.push({
      slug: guide.slug,
      title: guide.title,
      lang: guide.lang,
      summary: guide.summary,
      stageCount: guide.stages.length,
      commitCount,
    });
    console.log(`${slug}: ${guide.stages.length} stages, ${commitCount} commits, ${guide.branches.length} branches`);
  } catch (error) {
    console.error(`${slug}: skipped — ${error.message.split('\n')[0]}`);
  }
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2));
console.log(`wrote ${index.length} guides to ${outDir}`);
