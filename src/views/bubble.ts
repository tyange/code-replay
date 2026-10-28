import { renderMarkdown } from './doc';

export interface BubbleAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

/** A speech bubble over the replay that narrates the stage */
export class BubbleView {
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly actions: HTMLElement;
  private shownKey = '';
  private handlers: BubbleAction[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly chip: HTMLElement,
  ) {
    root.innerHTML = `
      <div class="bubble-head">
        <span class="bubble-avatar" aria-hidden="true">💬</span>
        <span class="bubble-title"></span>
        <button type="button" class="bubble-close" aria-label="말풍선 접기" title="접기">–</button>
      </div>
      <div class="bubble-body markdown"></div>
      <div class="bubble-actions"></div>`;
    this.title = root.querySelector('.bubble-title') as HTMLElement;
    this.body = root.querySelector('.bubble-body') as HTMLElement;
    this.actions = root.querySelector('.bubble-actions') as HTMLElement;
    root.querySelector('.bubble-close')?.addEventListener('click', () => this.collapse());
    this.actions.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
      if (button) this.handlers[Number(button.dataset.index)]?.run();
    });
    chip.addEventListener('click', () => this.expand());
  }

  get open(): boolean {
    return this.root.classList.contains('open');
  }

  get hasContent(): boolean {
    return this.shownKey !== '';
  }

  /** Shows a note. `key` identifies it so the same note isn't re-rendered */
  show(key: string, title: string, markdown: string, actions: BubbleAction[]): void {
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.title.textContent = title;
      this.body.innerHTML = renderMarkdown(markdown);
      this.body.scrollTop = 0;
      this.handlers = actions;
      this.actions.innerHTML = actions
        .map(
          (a, i) =>
            `<button type="button" data-index="${i}" class="${a.primary ? 'primary' : ''}">${a.label}</button>`,
        )
        .join('');
    }
    this.expand();
  }

  /** Runs the primary action, if the bubble is open */
  confirm(): boolean {
    if (!this.open) return false;
    const primary = this.handlers.find((a) => a.primary);
    primary?.run();
    return Boolean(primary);
  }

  collapse(): void {
    this.root.classList.remove('open');
    this.chip.hidden = !this.hasContent;
  }

  expand(): void {
    if (!this.hasContent) return;
    this.root.classList.add('open');
    this.chip.hidden = true;
  }

  clear(): void {
    this.shownKey = '';
    this.root.classList.remove('open');
    this.chip.hidden = true;
  }
}
