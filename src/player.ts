import {
  applyStep,
  buildPlan,
  emptyState,
  stateAt,
  stepDelay,
  stopAfter,
  stopBefore,
  type EditorState,
  type Plan,
} from './engine';
import type { Commit } from './types';

export interface Playlist {
  /** Stage id, or branch name for an experiment branch */
  key: string;
  title: string;
  commits: Commit[];
}

const MAX_STEPS_PER_TICK = 400;

/** Plays the commits of one playlist (a stage or a branch) one after another */
export class Player {
  playlist: Playlist | null = null;
  commitIndex = 0;
  plan: Plan = { steps: [], lineStops: [], changeStops: [], fileStarts: [] };
  step = 0;
  state: EditorState = emptyState();
  playing = false;
  ended = false;
  speedMs: number;

  /** Called whenever something visible changed */
  onChange: () => void = () => {};
  /** Called once when the last commit of the playlist has been typed */
  onEnd: () => void = () => {};
  /** Called after a commit is loaded, before any of it is typed */
  onCommit: (index: number) => void = () => {};

  private nextAt = 0;
  private advanceAt: number | null = null;

  constructor(speedMs: number) {
    this.speedMs = speedMs;
  }

  get commit(): Commit | null {
    return this.playlist?.commits[this.commitIndex] ?? null;
  }

  /** (done, total) steps of the current commit */
  get progress(): number {
    return this.plan.steps.length === 0 ? 0 : this.step / this.plan.steps.length;
  }

  load(playlist: Playlist, commitIndex = 0, autoplay = true): void {
    this.playlist = playlist;
    this.loadCommit(commitIndex, autoplay);
  }

  loadCommit(index: number, autoplay = this.playing): void {
    const commits = this.playlist?.commits ?? [];
    this.commitIndex = Math.max(0, Math.min(index, commits.length - 1));
    const commit = this.commit;
    this.plan = commit ? buildPlan(commit) : { steps: [], lineStops: [], changeStops: [], fileStarts: [] };
    this.step = 0;
    this.state = emptyState();
    // Show the first file right away, even when paused
    if (commit && this.plan.steps.length > 0) this.exec();
    this.ended = false;
    this.advanceAt = null;
    this.playing = autoplay;
    this.nextAt = performance.now();
    this.onCommit(this.commitIndex);
    this.onChange();
  }

  tick(now: number): void {
    if (!this.playing || !this.commit) return;

    if (this.step >= this.plan.steps.length) {
      this.advanceAt ??= now + 900 * Math.min(Math.max(this.speedMs / 40, 0.5), 3);
      if (now >= this.advanceAt) this.next(true);
      return;
    }

    // After a long pause (hidden tab), don't race to catch up
    if (now - this.nextAt > 1000) this.nextAt = now;

    let ran = 0;
    let changed = false;
    while (this.step < this.plan.steps.length && now >= this.nextAt && ran < MAX_STEPS_PER_TICK) {
      const delay = this.exec();
      this.nextAt += delay;
      ran++;
      changed = true;
    }
    if (changed) this.onChange();
  }

  /** Runs the next step and returns how long to wait before the one after */
  private exec(): number {
    const step = this.plan.steps[this.step];
    const commit = this.commit;
    if (!step || !commit) return 0;
    applyStep(this.state, step, commit);
    this.step++;
    return stepDelay(step, this.speedMs);
  }

  private seekStep(index: number): void {
    const commit = this.commit;
    if (!commit) return;
    this.step = Math.max(0, Math.min(index, this.plan.steps.length));
    this.state = stateAt(this.plan, commit, this.step);
    if (this.step === 0 && this.plan.steps.length > 0) this.exec();
    this.ended = false;
    this.advanceAt = null;
    this.onChange();
  }

  togglePlay(): void {
    if (this.ended) {
      this.loadCommit(0, true);
      return;
    }
    this.playing = !this.playing;
    this.nextAt = performance.now();
    this.onChange();
  }

  pause(): void {
    this.playing = false;
    this.onChange();
  }

  play(): void {
    if (!this.playing) this.togglePlay();
  }

  lineBack(): void {
    this.playing = false;
    this.seekStep(stopBefore(this.plan.lineStops, this.step));
  }

  lineForward(): void {
    this.playing = false;
    this.seekStep(stopAfter(this.plan.lineStops, this.step, this.plan.steps.length));
  }

  changeBack(): void {
    this.playing = false;
    this.seekStep(stopBefore(this.plan.changeStops, this.step));
  }

  changeForward(): void {
    this.playing = false;
    this.seekStep(stopAfter(this.plan.changeStops, this.step, this.plan.steps.length));
  }

  restart(): void {
    this.loadCommit(this.commitIndex, true);
  }

  prev(): void {
    if (this.commitIndex > 0) this.loadCommit(this.commitIndex - 1, true);
    else this.restart();
  }

  /** Next commit. `auto` is true when the playlist advances on its own */
  next(auto = false): void {
    const total = this.playlist?.commits.length ?? 0;
    if (this.commitIndex + 1 < total) {
      this.loadCommit(this.commitIndex + 1, true);
      return;
    }
    // Pressing next again at the end shouldn't announce the end twice
    const alreadyEnded = this.ended;
    if (!auto && !alreadyEnded) this.seekStep(this.plan.steps.length);
    this.playing = false;
    this.ended = true;
    this.advanceAt = null;
    this.onChange();
    if (!alreadyEnded) this.onEnd();
  }

  seekCommit(index: number): void {
    this.loadCommit(index, true);
  }

  setSpeed(ms: number): void {
    this.speedMs = Math.max(5, Math.min(500, Math.round(ms)));
    this.onChange();
  }

  changeSpeed(faster: boolean): void {
    const current = this.speedMs;
    const step = current < 20 ? 5 : current < 100 ? 10 : 50;
    this.setSpeed(faster ? current - step : current + step);
  }
}
