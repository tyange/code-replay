#!/usr/bin/env node
// code-replay CLI: serves the player on localhost and manages learning sessions (one file per guide).
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { importGuideFolder } from '../lib/import-repo.mjs';
import {
  ensureDir,
  guideSummary,
  isSessionFile,
  loadSessions,
  readSession,
  SESSION_EXTENSIONS,
  sessionToGuide,
  writeSession,
} from '../lib/sessions.mjs';

const root = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..');
const dist = join(root, 'dist');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const cyan = paint('36');
const red = paint('31');
const yellow = paint('33');

const HELP = `
${bold('code-replay')} ${dim(`v${version}`)} — Craft 가이드를 타이핑 애니메이션으로 재생하며 따라 치기

${bold('사용법')}
  code-replay [serve]          로컬 서버를 띄우고 주소를 보여 줍니다
      --port <n>               포트 (기본 5170, 사용 중이면 다음 번호)
      --open                   브라우저도 엽니다
  code-replay list             세션 목록
  code-replay add <파일...>    세션 파일(.yaml .yml .json .toml)을 세션 폴더에 추가
      --force                  같은 slug 가 있으면 덮어쓰기
  code-replay remove <slug>    세션 삭제 (-y 로 확인 생략)
  code-replay import <폴더>    guide.json + git 저장소 형식의 가이드를 세션 파일로 변환해 추가
      --format yaml|json|toml  (기본 yaml)
  code-replay new <slug>       빈 세션 파일 틀을 만듭니다
  code-replay path             세션 폴더 경로
  code-replay theme add <파일> VS Code 테마 JSON 추가 (설정의 테마 목록에 나옵니다)
  code-replay theme list       추가한 테마 목록
  code-replay theme remove <이름>

${bold('공통 옵션')}
  --dir <폴더>                 세션 폴더 (기본 ~/.code-replay/sessions, 환경변수 CODE_REPLAY_HOME)

세션 폴더에 파일을 넣으면 추가, 지우면 삭제됩니다. 이름이 _ 로 시작하는 파일은 무시합니다.
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-y') args.flags.yes = true;
    else if (arg === '-h') args.flags.help = true;
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      const takesValue = ['port', 'dir', 'format'].includes(key);
      args.flags[key] = takesValue ? (inline ?? argv[++i]) : true;
    } else args._.push(arg);
  }
  return args;
}

function homeDir() {
  return process.env.CODE_REPLAY_HOME ? resolve(process.env.CODE_REPLAY_HOME) : join(homedir(), '.code-replay');
}

function sessionsDir(flags) {
  return flags.dir ? resolve(flags.dir) : join(homeDir(), 'sessions');
}

function themesDir() {
  return join(homeDir(), 'themes');
}

/** VS Code theme files are JSON with comments and trailing commas */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Theme files in ~/.code-replay/themes, as { id, theme } for the web app */
function loadThemes() {
  const dir = themesDir();
  if (!existsSync(dir)) return [];
  const themes = [];
  for (const name of readdirSyncSafe(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const theme = parseJsonc(readFileSync(join(dir, name), 'utf8'));
      themes.push({ id: basename(name, '.json'), theme: { ...theme, name: theme.name ?? basename(name, '.json') } });
    } catch (error) {
      console.log(`  ${yellow('!')} 테마 ${name} ${dim(`— ${error.message}`)}`);
    }
  }
  return themes;
}

function die(message) {
  console.error(`${red('✗')} ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- serve

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** Session files → guide JSON, rebuilt only when a file in the folder changes */
function createLibrary(dir) {
  let stamp = '';
  let cache = { index: [], guides: new Map(), errors: [] };
  // Cheap change detection: file names and modification times, no parsing
  const currentStamp = () =>
    listSessionFiles(dir)
      .map((p) => `${p}:${statSync(p).mtimeMs}`)
      .join('|');
  return {
    get() {
      const next = currentStamp();
      if (next !== stamp) {
        stamp = next;
        const { sessions, errors } = loadSessions(dir);
        const guides = new Map(sessions.map(({ session }) => [session.slug, sessionToGuide(session)]));
        cache = { index: [...guides.values()].map(guideSummary), guides, errors };
      }
      return cache;
    },
  };
}

function listSessionFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSyncSafe(dir)
    .filter((name) => !name.startsWith('_') && !name.startsWith('.') && isSessionFile(name))
    .map((name) => join(dir, name));
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist + sep) && file !== dist) return send(res, 403, 'forbidden');
  const target = existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html');
  const type = MIME[extname(target)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    // Built assets have hashed names; the page itself must always be fresh
    'cache-control': target.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(readFileSync(target));
}

function listen(server, port, tries = 20) {
  return new Promise((done, failed) => {
    const attempt = (p, left) => {
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && left > 0) attempt(p + 1, left - 1);
        else failed(error);
      });
      server.listen(p, '127.0.0.1', () => done(p));
    };
    attempt(port, tries);
  });
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(command, args, () => {});
}

async function serve(flags) {
  const started = performance.now();
  if (!existsSync(join(dist, 'index.html'))) {
    die(`웹 앱이 빌드되어 있지 않습니다. ${cyan(`cd ${root} && pnpm build`)} 를 먼저 실행하세요.`);
  }
  const dir = sessionsDir(flags);
  ensureDir(dir);
  const library = createLibrary(dir);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/data/themes.json') {
      return send(res, 200, JSON.stringify(loadThemes()), MIME['.json']);
    }
    if (url.pathname === '/data/index.json') {
      return send(res, 200, JSON.stringify(library.get().index), MIME['.json']);
    }
    const match = /^\/data\/([^/]+)\.json$/.exec(url.pathname);
    if (match) {
      const guide = library.get().guides.get(decodeURIComponent(match[1]));
      return guide ? send(res, 200, JSON.stringify(guide), MIME['.json']) : send(res, 404, 'no such session');
    }
    serveStatic(req, res);
  });

  const port = await listen(server, Number(flags.port ?? 5170));
  const url = `http://localhost:${port}/`;
  const { index, errors } = library.get();
  const ms = Math.round(performance.now() - started);

  console.log(`\n  ${bold(green('code-replay'))} ${green(`v${version}`)}  ${dim('ready in')} ${bold(ms)} ${dim('ms')}\n`);
  console.log(`  ${green('➜')}  ${bold('Local')}:    ${cyan(url)}`);
  console.log(`  ${green('➜')}  ${bold('Sessions')}: ${index.length}개 ${dim(`(${dir})`)}`);
  for (const g of index) console.log(`     ${dim('·')} ${g.slug} ${dim(`— 단계 ${g.stageCount}, 커밋 ${g.commitCount}`)}`);
  for (const e of errors) console.log(`     ${yellow('!')} ${basename(e.path)} ${dim(`— ${e.message}`)}`);
  if (index.length === 0) console.log(`     ${dim('세션이 없습니다.')} ${cyan('code-replay add <파일>')} ${dim('또는')} ${cyan('code-replay import <폴더>')}`);
  const themes = loadThemes();
  if (themes.length) console.log(`  ${green('➜')}  ${bold('Themes')}:   ${themes.map((t) => t.theme.name).join(', ')}`);
  console.log(`\n  ${dim('VS Code 안에서 보려면:')} Cmd/Ctrl+Shift+P → ${bold('Simple Browser: Show')} → ${cyan(url)}`);
  console.log(`  ${dim('종료는 Ctrl+C')}\n`);
  if (flags.open) openBrowser(url);

  // Tell the user when sessions are added or removed while the server runs
  let timer;
  let last = index.map((g) => g.slug).join(',');
  try {
    watch(dir, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { index: now, errors: errs } = library.get();
        const slugs = now.map((g) => g.slug).join(',');
        if (slugs !== last) {
          last = slugs;
          console.log(`  ${green('↻')} 세션 ${now.length}개: ${now.map((g) => g.slug).join(', ') || '(없음)'} ${dim('— 브라우저를 새로고침하세요')}`);
        }
        for (const e of errs) console.log(`  ${yellow('!')} ${basename(e.path)} ${dim(`— ${e.message}`)}`);
      }, 200);
    });
  } catch {
    // watching isn't essential
  }
}

// ---------------------------------------------------------------- session management

function list(flags) {
  const dir = sessionsDir(flags);
  const { sessions, errors } = loadSessions(dir);
  console.log(dim(dir));
  if (sessions.length === 0) console.log('세션이 없습니다.');
  for (const { path, session } of sessions) {
    const commits = session.stages.reduce((n, s) => n + s.steps.length, 0);
    console.log(`${bold(session.slug.padEnd(18))} ${session.title} ${dim(`· 단계 ${session.stages.length} · 커밋 ${commits} · ${basename(path)}`)}`);
  }
  for (const e of errors) console.log(`${yellow('!')} ${basename(e.path)} ${dim(`— ${e.message}`)}`);
}

function findBySlug(dir, slug) {
  return loadSessions(dir).sessions.find(({ session }) => session.slug === slug);
}

function add(files, flags) {
  if (files.length === 0) die('추가할 세션 파일을 주세요. 예: code-replay add ./roguelike.yaml');
  const dir = sessionsDir(flags);
  ensureDir(dir);
  for (const file of files) {
    if (!isSessionFile(file)) die(`${file}: 확장자는 ${SESSION_EXTENSIONS.join(' ')} 중 하나여야 합니다`);
    let session;
    try {
      session = readSession(file);
    } catch (error) {
      die(error.message);
    }
    const existing = findBySlug(dir, session.slug);
    if (existing && !flags.force) die(`slug "${session.slug}" 가 이미 있습니다 (${basename(existing.path)}). 덮어쓰려면 --force`);
    if (existing) unlinkSync(existing.path);
    const target = join(dir, `${session.slug}${extname(file).toLowerCase()}`);
    copyFileSync(file, target);
    console.log(`${green('✓')} ${session.slug} 추가 ${dim(`→ ${target}`)}`);
  }
}

async function remove(slug, flags) {
  if (!slug) die('지울 세션의 slug 를 주세요. 목록은 code-replay list');
  const dir = sessionsDir(flags);
  const found = findBySlug(dir, slug);
  if (!found) die(`"${slug}" 세션이 없습니다. 목록은 code-replay list`);
  if (!flags.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`${found.session.title} (${basename(found.path)}) 를 지울까요? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('취소했습니다.');
      return;
    }
  }
  unlinkSync(found.path);
  console.log(`${green('✓')} ${slug} 삭제`);
}

function importFolder(folder, flags) {
  if (!folder) die('가이드 폴더를 주세요. 예: code-replay import ~/code-replay-src/roguelike');
  if (!existsSync(join(folder, 'guide.json'))) die(`${folder}: guide.json 이 없습니다`);
  const format = flags.format ?? 'yaml';
  if (!['yaml', 'json', 'toml'].includes(format)) die('--format 은 yaml, json, toml 중 하나입니다');
  const dir = sessionsDir(flags);
  ensureDir(dir);
  let session;
  try {
    session = importGuideFolder(resolve(folder));
  } catch (error) {
    die(error.message.split('\n')[0]);
  }
  const existing = findBySlug(dir, session.slug);
  if (existing && !flags.force) die(`slug "${session.slug}" 가 이미 있습니다 (${basename(existing.path)}). 덮어쓰려면 --force`);
  if (existing) unlinkSync(existing.path);
  const target = join(dir, `${session.slug}.${format}`);
  writeSession(target, session);
  const commits = session.stages.reduce((n, s) => n + s.steps.length, 0);
  console.log(`${green('✓')} ${session.slug} 가져옴 ${dim(`· 단계 ${session.stages.length} · 커밋 ${commits} → ${target}`)}`);
}

function scaffold(slug, flags) {
  if (!slug) die('slug 를 주세요. 예: code-replay new my-guide');
  const dir = sessionsDir(flags);
  ensureDir(dir);
  const target = join(dir, `${slug}.yaml`);
  if (existsSync(target)) die(`${target} 가 이미 있습니다`);
  writeSession(target, {
    slug,
    title: slug,
    summary: '무엇을 만들고 무엇을 배우는지 한두 문장',
    lang: 'rust',
    intro: `# ${slug}\n\n가이드 소개 (Markdown)\n`,
    stages: [
      {
        id: '1',
        title: '첫 단계',
        doc: '# 첫 단계\n\n이 단계에서 할 일.\n\n▶ `src/main.rs` — 재생에서 따라 칩니다\n\n### 확인\n\n- cargo run 으로 출력 확인\n',
        steps: [{ message: '[1] main.rs — 시작', file: 'src/main.rs', content: 'fn main() {\n    println!("hello");\n}\n' }],
      },
    ],
  });
  console.log(`${green('✓')} 새 세션 틀 ${dim(`→ ${target}`)}`);
}

// ---------------------------------------------------------------- themes

async function theme([action, arg], flags) {
  const dir = themesDir();
  if (action === 'list' || !action) {
    const themes = loadThemes();
    console.log(dim(dir));
    if (themes.length === 0) console.log('추가한 테마가 없습니다. 기본 테마는 웹 화면의 ⚙ 에서 고릅니다.');
    for (const t of themes) console.log(`${bold(t.id.padEnd(24))} ${t.theme.name} ${dim(t.theme.type ?? '')}`);
    return;
  }
  if (action === 'add') {
    if (!arg) die('VS Code 테마 JSON 파일을 주세요. 예: code-replay theme add ./my-theme.json');
    let parsed;
    try {
      parsed = parseJsonc(readFileSync(arg, 'utf8'));
    } catch (error) {
      die(`${arg}: JSON 으로 읽지 못했습니다 — ${error.message}`);
    }
    if (!parsed?.colors && !parsed?.tokenColors) die(`${arg}: colors 나 tokenColors 가 없습니다. VS Code 색 테마 파일이 맞나요?`);
    ensureDir(dir);
    const id = (parsed.name ?? basename(arg, extname(arg))).toLowerCase().replace(/[^a-z0-9가-힣._-]+/g, '-');
    const target = join(dir, `${id}.json`);
    if (existsSync(target) && !flags.force) die(`${basename(target)} 가 이미 있습니다. 덮어쓰려면 --force`);
    copyFileSync(arg, target);
    console.log(`${green('✓')} 테마 추가 ${dim(`→ ${target}`)} ${dim('— 웹 화면 ⚙ 의 "내 테마" 에서 고르세요 (새로고침)')}`);
    return;
  }
  if (action === 'remove' || action === 'rm') {
    const target = join(dir, `${arg ?? ''}.json`);
    if (!arg || !existsSync(target)) die(`"${arg ?? ''}" 테마가 없습니다. 목록은 code-replay theme list`);
    unlinkSync(target);
    console.log(`${green('✓')} 테마 ${arg} 삭제`);
    return;
  }
  die('theme 다음에는 add, list, remove 중 하나를 쓰세요');
}

// ---------------------------------------------------------------- main

const { _: positional, flags } = parseArgs(process.argv.slice(2));
const [command = 'serve', ...rest] = positional;

if (flags.help || command === 'help') console.log(HELP);
else if (flags.version || command === 'version') console.log(version);
else if (command === 'serve' || command === 'dev') await serve(flags);
else if (command === 'list' || command === 'ls') list(flags);
else if (command === 'add') add(rest, flags);
else if (command === 'remove' || command === 'rm') await remove(rest[0], flags);
else if (command === 'import') importFolder(rest[0], flags);
else if (command === 'new') scaffold(rest[0], flags);
else if (command === 'path') console.log(sessionsDir(flags));
else if (command === 'theme') await theme(rest, flags);
else die(`알 수 없는 명령: ${command}\n${HELP}`);
