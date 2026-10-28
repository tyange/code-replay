import { diffArrays } from 'diff';
import type { Commit } from './types';

/**
 * One atomic edit of the replay. A commit becomes a flat list of steps, so any point of the
 * animation can be rebuilt by replaying steps from the start of its file.
 */
export type Step =
  | { t: 'file'; file: number }
  | { t: 'mark'; line: number; count: number }
  | { t: 'del'; line: number }
  | { t: 'nl'; line: number }
  | { t: 'type'; line: number; col: number; text: string }
  | { t: 'wait'; ms: number };

export interface Plan {
  steps: Step[];
  /** Step indices where a new line starts being typed or deleted */
  lineStops: number[];
  /** Step indices where a hunk (a run of deletions and/or insertions) starts */
  changeStops: number[];
  /** Step index of each file's `file` step, by file index */
  fileStarts: number[];
}

export interface EditorState {
  file: number;
  lines: string[];
  cursor: { line: number; col: number };
  marked: { line: number; count: number } | null;
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function isBinary(text: string): boolean {
  return text.includes('\0');
}

export function buildPlan(commit: Commit): Plan {
  const steps: Step[] = [];
  const lineStops: number[] = [];
  const changeStops: number[] = [];
  const fileStarts: number[] = [];

  commit.files.forEach((change, file) => {
    fileStarts[file] = steps.length;
    steps.push({ t: 'file', file });
    if (isBinary(change.before) || isBinary(change.after)) return;
    steps.push({ t: 'wait', ms: 500 });

    let pos = 0;
    let inHunk = false;
    for (const part of diffArrays(splitLines(change.before), splitLines(change.after))) {
      if (!part.added && !part.removed) {
        pos += part.value.length;
        inHunk = false;
        continue;
      }
      if (!inHunk) changeStops.push(steps.length);
      inHunk = true;

      if (part.removed) {
        steps.push({ t: 'mark', line: pos, count: part.value.length });
        steps.push({ t: 'wait', ms: 350 });
        for (let i = 0; i < part.value.length; i++) {
          lineStops.push(steps.length);
          steps.push({ t: 'del', line: pos });
        }
        continue;
      }

      for (const text of part.value) {
        lineStops.push(steps.length);
        steps.push({ t: 'nl', line: pos });
        // Indentation appears at once, like an editor's auto-indent; the rest is typed
        const indent = /^\s*/.exec(text)?.[0] ?? '';
        let col = 0;
        if (indent) {
          steps.push({ t: 'type', line: pos, col, text: indent });
          col += indent.length;
        }
        for (const ch of text.slice(indent.length)) {
          steps.push({ t: 'type', line: pos, col, text: ch });
          col += ch.length;
        }
        pos++;
      }
    }
    steps.push({ t: 'wait', ms: 700 });
  });

  return { steps, lineStops, changeStops, fileStarts };
}

export function emptyState(): EditorState {
  return { file: -1, lines: [], cursor: { line: 0, col: 0 }, marked: null };
}

export function applyStep(state: EditorState, step: Step, commit: Commit): void {
  switch (step.t) {
    case 'file': {
      const change = commit.files[step.file];
      state.file = step.file;
      state.lines = isBinary(change.before) ? [] : splitLines(change.before);
      state.cursor = { line: 0, col: 0 };
      state.marked = null;
      break;
    }
    case 'mark':
      state.marked = { line: step.line, count: step.count };
      state.cursor = { line: step.line, col: 0 };
      break;
    case 'del':
      state.lines.splice(step.line, 1);
      if (state.marked) {
        state.marked.count -= 1;
        if (state.marked.count <= 0) state.marked = null;
      }
      state.cursor = { line: Math.min(step.line, Math.max(state.lines.length - 1, 0)), col: 0 };
      break;
    case 'nl':
      state.marked = null;
      state.lines.splice(step.line, 0, '');
      state.cursor = { line: step.line, col: 0 };
      break;
    case 'type': {
      const text = state.lines[step.line] ?? '';
      state.lines[step.line] = text.slice(0, step.col) + step.text + text.slice(step.col);
      state.cursor = { line: step.line, col: step.col + step.text.length };
      break;
    }
    case 'wait':
      break;
  }
}

/** The editor state after the first `index` steps */
export function stateAt(plan: Plan, commit: Commit, index: number): EditorState {
  const state = emptyState();
  if (index <= 0) return state;
  let start = 0;
  for (const fileStart of plan.fileStarts) {
    if (fileStart !== undefined && fileStart < index) start = fileStart;
  }
  for (let i = start; i < index && i < plan.steps.length; i++) {
    applyStep(state, plan.steps[i], commit);
  }
  return state;
}

/** The nearest stop before `index`, or 0 */
export function stopBefore(stops: number[], index: number): number {
  let found = 0;
  for (const stop of stops) {
    if (stop < index) found = stop;
    else break;
  }
  return found;
}

/** The nearest stop after `index`, or `end` */
export function stopAfter(stops: number[], index: number, end: number): number {
  for (const stop of stops) {
    if (stop > index) return stop;
  }
  return end;
}

/** How long to wait after a step, given the typing speed in ms per character */
export function stepDelay(step: Step, speedMs: number): number {
  switch (step.t) {
    case 'type':
      return step.text.trim() === '' ? speedMs : speedMs * (0.6 + Math.random() * 0.8);
    case 'nl':
      return speedMs * 3;
    case 'del':
      return Math.max(speedMs, 25);
    case 'mark':
      return 0;
    case 'file':
      return 0;
    case 'wait':
      return step.ms * Math.min(Math.max(speedMs / 40, 0.5), 3);
  }
}
