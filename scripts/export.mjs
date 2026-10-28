// Writes the sessions as static JSON for a hosted build (GitHub Pages). The CLI serves the same
// data on the fly, so this is only needed for publishing.
//
//   node scripts/export.mjs [sessions dir]   (default: the CLI's folder, ~/.code-replay/sessions)
//
// A session with `publish: false` stays out of the static build.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guideSummary, loadSessions, sessionToGuide } from '../lib/sessions.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.CODE_REPLAY_HOME ?? join(homedir(), '.code-replay');
const dir = resolve(process.argv[2] ?? join(home, 'sessions'));
const outDir = join(root, 'public', 'data');

const { sessions, errors } = loadSessions(dir);
for (const e of errors) console.error(`skipped ${e.path}: ${e.message}`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const index = [];
for (const { session } of sessions) {
  if (session.publish === false) {
    console.log(`${session.slug}: publish: false — skipped`);
    continue;
  }
  const guide = sessionToGuide(session);
  writeFileSync(join(outDir, `${guide.slug}.json`), JSON.stringify(guide));
  const summary = guideSummary(guide);
  index.push(summary);
  console.log(`${guide.slug}: ${summary.stageCount} stages, ${summary.commitCount} commits`);
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2));
console.log(`wrote ${index.length} guides to ${outDir}`);
