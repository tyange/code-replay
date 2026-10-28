import type { Player } from '../player';

export type ControlAction =
  | 'prev'
  | 'changeBack'
  | 'lineBack'
  | 'toggle'
  | 'lineForward'
  | 'changeForward'
  | 'next'
  | 'restart'
  | 'slower'
  | 'faster';

const BUTTONS: Array<{ action: ControlAction; label: string; title: string; key: string }> = [
  { action: 'prev', label: '⏮', title: '이전 커밋', key: 'p' },
  { action: 'changeBack', label: '«', title: '변경 단위 뒤로', key: 'H' },
  { action: 'lineBack', label: '‹', title: '한 줄 뒤로', key: 'h' },
  { action: 'toggle', label: '▶', title: '재생 / 일시정지', key: 'Space' },
  { action: 'lineForward', label: '›', title: '한 줄 앞으로', key: 'l' },
  { action: 'changeForward', label: '»', title: '변경 단위 앞으로', key: 'L' },
  { action: 'next', label: '⏭', title: '다음 커밋', key: 'n' },
  { action: 'restart', label: '↺', title: '이 커밋 처음부터', key: 'r' },
];

/** Media-player bar: a progress row of commits and a row of buttons */
export class ControlsView {
  private readonly segments: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly speed: HTMLElement;
  private readonly position: HTMLElement;
  private readonly title: HTMLElement;
  private segmentKey = '';

  constructor(
    root: HTMLElement,
    private readonly onAction: (action: ControlAction) => void,
    private readonly onSeek: (commit: number) => void,
  ) {
    root.innerHTML = `
      <div class="progress-row">
        <span class="position"></span>
        <div class="segments" role="group" aria-label="커밋 진행"></div>
      </div>
      <div class="button-row">
        <div class="buttons"></div>
        <div class="speed">
          <button type="button" data-action="slower" title="느리게 ( - )">−</button>
          <span class="speed-value"></span>
          <button type="button" data-action="faster" title="빠르게 ( + )">+</button>
        </div>
        <div class="commit-title"></div>
      </div>`;
    const buttons = root.querySelector('.buttons') as HTMLElement;
    for (const b of BUTTONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = b.action;
      button.textContent = b.label;
      button.title = `${b.title} (${b.key})`;
      button.setAttribute('aria-label', b.title);
      if (b.action === 'toggle') button.classList.add('primary');
      buttons.append(button);
    }
    root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (button?.dataset.action) {
        this.onAction(button.dataset.action as ControlAction);
        (button as HTMLButtonElement).blur();
      }
      const segment = (event.target as HTMLElement).closest<HTMLElement>('[data-commit]');
      if (segment?.dataset.commit) this.onSeek(Number(segment.dataset.commit));
    });
    this.segments = root.querySelector('.segments') as HTMLElement;
    this.toggle = root.querySelector('[data-action="toggle"]') as HTMLButtonElement;
    this.speed = root.querySelector('.speed-value') as HTMLElement;
    this.position = root.querySelector('.position') as HTMLElement;
    this.title = root.querySelector('.commit-title') as HTMLElement;
  }

  render(player: Player): void {
    const commits = player.playlist?.commits ?? [];
    const key = `${player.playlist?.key}:${commits.length}`;
    if (key !== this.segmentKey) {
      this.segmentKey = key;
      this.segments.innerHTML = commits
        .map(
          (c, i) =>
            `<button type="button" class="segment" data-commit="${i}" title="${escapeAttr(c.message)}"><span class="fill"></span></button>`,
        )
        .join('');
    }
    this.segments.querySelectorAll<HTMLElement>('.segment').forEach((segment, i) => {
      const fill = segment.firstElementChild as HTMLElement;
      const ratio = i < player.commitIndex ? 1 : i === player.commitIndex ? player.progress : 0;
      fill.style.width = `${ratio * 100}%`;
      segment.classList.toggle('current', i === player.commitIndex);
    });

    this.position.textContent = commits.length ? `${player.commitIndex + 1}/${commits.length}` : '-/-';
    this.toggle.textContent = player.playing ? '⏸' : '▶';
    this.toggle.classList.toggle('playing', player.playing);
    this.speed.textContent = `${player.speedMs}ms`;
    const message = player.commit?.message ?? '';
    this.title.textContent = player.ended ? `END · ${message}` : message;
    this.title.classList.toggle('ended', player.ended);
  }
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
