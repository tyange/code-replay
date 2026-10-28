export type FileStatus = 'A' | 'M' | 'D' | 'R';

export interface FileChange {
  path: string;
  status: FileStatus;
  oldPath?: string;
  before: string;
  after: string;
}

export interface Commit {
  hash: string;
  message: string;
  date: string;
  files: FileChange[];
  /** Every file path in the tree after this commit */
  tree: string[];
}

export interface Stage {
  id: string;
  title: string;
  doc: string;
  commits: Commit[];
}

export interface Branch {
  name: string;
  title: string;
  /** Stage id the branch was made from */
  after: string;
  doc: string;
  commits: Commit[];
}

export interface Guide {
  slug: string;
  title: string;
  lang: string;
  summary: string;
  source: string;
  intro: string;
  stages: Stage[];
  branches: Branch[];
}

export interface GuideSummary {
  slug: string;
  title: string;
  lang: string;
  summary: string;
  stageCount: number;
  commitCount: number;
}
