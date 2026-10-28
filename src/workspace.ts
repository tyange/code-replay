import type { Commit, Guide } from './types';

/** The files of a project at some point of the replay */
export type Snapshot = Map<string, string>;

export function applyCommit(files: Snapshot, commit: Commit): void {
  for (const change of commit.files) {
    if (change.status === 'R' && change.oldPath) files.delete(change.oldPath);
    if (change.status === 'D') files.delete(change.path);
    else files.set(change.path, change.after);
  }
}

/**
 * The project as it is right before commit `commitIndex` of the playlist `key` (a stage id or a
 * branch name). Every guide starts from an empty tree, so replaying all earlier commits rebuilds it.
 */
export function snapshotBefore(guide: Guide, key: string, commitIndex: number): Snapshot {
  const files: Snapshot = new Map();
  const branch = guide.branches.find((b) => b.name === key);
  const stageKey = branch ? branch.after : key;
  for (const stage of guide.stages) {
    if (stage.id === stageKey && !branch) {
      stage.commits.slice(0, commitIndex).forEach((c) => applyCommit(files, c));
      return files;
    }
    stage.commits.forEach((c) => applyCommit(files, c));
    if (stage.id === stageKey) break;
  }
  branch?.commits.slice(0, commitIndex).forEach((c) => applyCommit(files, c));
  return files;
}

/** The user's own files for one guide, kept in this browser */
export const workspaceStore = {
  key: (slug: string) => `code-replay:workspace:${slug}`,
  load(slug: string): { files: Record<string, string>; active?: string } {
    try {
      const raw = localStorage.getItem(this.key(slug));
      if (raw) return JSON.parse(raw) as { files: Record<string, string>; active?: string };
    } catch {
      // unavailable or corrupt storage: start empty
    }
    return { files: {} };
  },
  save(slug: string, files: Record<string, string>, active?: string): boolean {
    try {
      localStorage.setItem(this.key(slug), JSON.stringify({ files, active }));
      return true;
    } catch {
      return false;
    }
  },
};
