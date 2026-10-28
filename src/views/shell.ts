export interface ShellHost {
  prompt(): string;
  run(command: string, args: string[]): void;
  /** Candidates for completing the word at `index` of the line */
  complete(words: string[], index: number): string[];
}

const MAX_LOG_LINES = 300;

/** A small terminal: a scrolling log and a prompt line with history and Tab completion */
export class Shell {
  private history: string[] = [];
  private historyIndex = 0;

  constructor(
    private readonly log: HTMLElement,
    form: HTMLFormElement,
    private readonly input: HTMLInputElement,
    private readonly promptEl: HTMLElement,
    private readonly host: ShellHost,
  ) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    input.addEventListener('keydown', (event) => this.onKey(event));
    log.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
      if (target?.dataset.cmd) this.exec(target.dataset.cmd);
    });
    this.updatePrompt();
  }

  focus(): void {
    this.input.focus();
  }

  blur(): void {
    this.input.blur();
  }

  get focused(): boolean {
    return document.activeElement === this.input;
  }

  updatePrompt(): void {
    this.promptEl.textContent = this.host.prompt();
  }

  /** Runs a command as if it had been typed */
  exec(line: string): void {
    this.echo(line);
    this.dispatch(line);
  }

  print(text: string, cls = ''): void {
    const row = document.createElement('div');
    row.className = `log-line ${cls}`.trim();
    row.textContent = text;
    this.append(row);
  }

  /** Prints trusted HTML built by the app (never user input) */
  printHtml(html: string, cls = ''): void {
    const row = document.createElement('div');
    row.className = `log-line ${cls}`.trim();
    row.innerHTML = html;
    this.append(row);
  }

  clear(): void {
    this.log.innerHTML = '';
  }

  private append(row: HTMLElement): void {
    this.log.append(row);
    while (this.log.childElementCount > MAX_LOG_LINES) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  private echo(line: string): void {
    const row = document.createElement('div');
    row.className = 'log-line echo';
    const prompt = document.createElement('span');
    prompt.className = 'prompt';
    prompt.textContent = this.host.prompt();
    row.append(prompt, document.createTextNode(` ${line}`));
    this.append(row);
  }

  private submit(): void {
    const line = this.input.value.trim();
    this.input.value = '';
    this.echo(line);
    if (line) {
      this.history.push(line);
      this.historyIndex = this.history.length;
    }
    this.dispatch(line);
  }

  private dispatch(line: string): void {
    const [command, ...args] = line.split(/\s+/).filter(Boolean);
    if (command) this.host.run(command, args);
    this.updatePrompt();
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (this.history.length === 0) return;
      const delta = event.key === 'ArrowUp' ? -1 : 1;
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
      this.input.value = this.history[this.historyIndex] ?? '';
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      this.completeInput();
      return;
    }
    if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault();
      this.clear();
      return;
    }
    if (event.key === 'Escape') {
      this.input.blur();
    }
  }

  private completeInput(): void {
    const value = this.input.value;
    const words = value.split(/\s+/);
    const index = words.length - 1;
    const prefix = words[index];
    const matches = this.host.complete(words, index).filter((c) => c.startsWith(prefix));
    if (matches.length === 1) {
      words[index] = matches[0];
      this.input.value = `${words.join(' ')} `;
    } else if (matches.length > 1) {
      const common = matches.reduce((a, b) => {
        let i = 0;
        while (i < a.length && a[i] === b[i]) i++;
        return a.slice(0, i);
      });
      if (common.length > prefix.length) {
        words[index] = common;
        this.input.value = words.join(' ');
      } else {
        this.echo(value);
        this.print(matches.join('  '), 'muted');
      }
    }
  }
}
