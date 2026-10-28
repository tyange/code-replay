/** Colours the replay needs. Everything else (panels, hovers, borders) is derived in CSS */
export interface Theme {
  id: string;
  name: string;
  kind: 'dark' | 'light';
  ui: {
    bg: string;
    panel: string;
    line: string;
    fg: string;
    muted: string;
    accent: string;
    cursorLine: string;
  };
  tokens: {
    comment: string;
    keyword: string;
    string: string;
    number: string;
    type: string;
    func: string;
    punct: string;
    variable: string;
    literal: string;
    attr: string;
  };
}

type Row = [string, string, Theme['kind'], string, string, string, string, string, string, string, ...string[]];

// id, name, kind, bg, panel, line, fg, muted, accent, cursorLine,
// comment, keyword, string, number, type, func, punct, variable, literal, attr
const ROWS: Row[] = [
  ['dark-plus', 'Dark+ (VS Code)', 'dark', '#1e1e1e', '#252526', '#3c3c3c', '#d4d4d4', '#858585', '#3794ff', '#2a2d2e',
    '#6a9955', '#569cd6', '#ce9178', '#b5cea8', '#4ec9b0', '#dcdcaa', '#d4d4d4', '#9cdcfe', '#569cd6', '#9cdcfe'],
  ['light-plus', 'Light+ (VS Code)', 'light', '#ffffff', '#f3f3f3', '#e5e5e5', '#1f1f1f', '#6e7681', '#005fb8', '#f0f0f0',
    '#008000', '#0000ff', '#a31515', '#098658', '#267f99', '#795e26', '#1f1f1f', '#001080', '#0000ff', '#e50000'],
  ['tokyo-night', 'Tokyo Night', 'dark', '#1a1b26', '#16161e', '#2a2e42', '#c0caf5', '#565f89', '#7aa2f7', '#24283b',
    '#565f89', '#bb9af7', '#9ece6a', '#ff9e64', '#7dcfff', '#7aa2f7', '#89ddff', '#c0caf5', '#ff9e64', '#e0af68'],
  ['one-dark-pro', 'One Dark Pro', 'dark', '#282c34', '#21252b', '#181a1f', '#abb2bf', '#495162', '#528bff', '#2c313c',
    '#7f848e', '#c678dd', '#98c379', '#d19a66', '#e5c07b', '#61afef', '#abb2bf', '#e06c75', '#d19a66', '#d19a66'],
  ['dracula', 'Dracula', 'dark', '#282a36', '#21222c', '#191a21', '#f8f8f2', '#6272a4', '#bd93f9', '#343746',
    '#6272a4', '#ff79c6', '#f1fa8c', '#bd93f9', '#8be9fd', '#50fa7b', '#f8f8f2', '#f8f8f2', '#bd93f9', '#50fa7b'],
  ['monokai', 'Monokai', 'dark', '#272822', '#1e1f1c', '#414339', '#f8f8f2', '#90908a', '#a6e22e', '#3e3d32',
    '#88846f', '#f92672', '#e6db74', '#ae81ff', '#66d9ef', '#a6e22e', '#f8f8f2', '#f8f8f2', '#ae81ff', '#a6e22e'],
  ['github-dark', 'GitHub Dark', 'dark', '#0d1117', '#010409', '#30363d', '#e6edf3', '#6e7681', '#2f81f7', '#161b22',
    '#8b949e', '#ff7b72', '#a5d6ff', '#79c0ff', '#ffa657', '#d2a8ff', '#e6edf3', '#ffa657', '#79c0ff', '#79c0ff'],
  ['github-light', 'GitHub Light', 'light', '#ffffff', '#f6f8fa', '#d0d7de', '#1f2328', '#8c959f', '#0969da', '#eaeef2',
    '#6e7781', '#cf222e', '#0a3069', '#0550ae', '#953800', '#8250df', '#1f2328', '#953800', '#0550ae', '#0550ae'],
  ['solarized-dark', 'Solarized Dark', 'dark', '#002b36', '#00212b', '#073642', '#839496', '#586e75', '#268bd2', '#073642',
    '#586e75', '#859900', '#2aa198', '#d33682', '#b58900', '#268bd2', '#839496', '#268bd2', '#b58900', '#93a1a1'],
  ['solarized-light', 'Solarized Light', 'light', '#fdf6e3', '#eee8d5', '#ddd6c1', '#657b83', '#93a1a1', '#268bd2', '#eee8d5',
    '#93a1a1', '#859900', '#2aa198', '#d33682', '#b58900', '#268bd2', '#657b83', '#268bd2', '#b58900', '#586e75'],
  ['nord', 'Nord', 'dark', '#2e3440', '#272c36', '#3b4252', '#d8dee9', '#4c566a', '#88c0d0', '#3b4252',
    '#616e88', '#81a1c1', '#a3be8c', '#b48ead', '#8fbcbb', '#88c0d0', '#eceff4', '#d8dee9', '#81a1c1', '#8fbcbb'],
  ['catppuccin-mocha', 'Catppuccin Mocha', 'dark', '#1e1e2e', '#181825', '#313244', '#cdd6f4', '#6c7086', '#89b4fa', '#2a2b3c',
    '#9399b2', '#cba6f7', '#a6e3a1', '#fab387', '#f9e2af', '#89b4fa', '#9399b2', '#cdd6f4', '#fab387', '#f9e2af'],
  ['catppuccin-latte', 'Catppuccin Latte', 'light', '#eff1f5', '#e6e9ef', '#ccd0da', '#4c4f69', '#8c8fa1', '#1e66f5', '#e6e9ef',
    '#7c7f93', '#8839ef', '#40a02b', '#fe640b', '#df8e1d', '#1e66f5', '#7c7f93', '#4c4f69', '#fe640b', '#df8e1d'],
  ['gruvbox-dark', 'Gruvbox Dark', 'dark', '#282828', '#1d2021', '#3c3836', '#ebdbb2', '#7c6f64', '#83a598', '#32302f',
    '#928374', '#fb4934', '#b8bb26', '#d3869b', '#fabd2f', '#8ec07c', '#ebdbb2', '#83a598', '#d3869b', '#fe8019'],
];

export const BUILTIN_THEMES: Theme[] = ROWS.map(
  ([id, name, kind, bg, panel, line, fg, muted, accent, cursorLine, comment, keyword, string, number, type, func, punct, variable, literal, attr]) => ({
    id,
    name,
    kind,
    ui: { bg, panel, line, fg, muted, accent, cursorLine },
    tokens: { comment, keyword, string, number, type, func, punct, variable, literal, attr },
  }),
);

export const AUTO_THEME = 'auto';

export function systemTheme(): Theme {
  const light = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  return BUILTIN_THEMES.find((t) => t.id === (light ? 'light-plus' : 'dark-plus')) ?? BUILTIN_THEMES[0];
}

// ---------------------------------------------------------------- VS Code theme JSON

interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: string };
}

export interface VsCodeThemeJson {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: TokenRule[];
}

/** VS Code theme files are JSON with comments and trailing commas */
export function parseJsonc(text: string): unknown {
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
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Colour of the most specific TextMate rule matching `scope` (selector "a.b" matches "a.b.c") */
function scopeColor(rules: TokenRule[], scope: string): string | undefined {
  let best: { length: number; color: string } | undefined;
  for (const rule of rules) {
    const color = rule.settings?.foreground;
    if (!color) continue;
    const selectors = Array.isArray(rule.scope)
      ? rule.scope
      : (rule.scope ?? '').split(',').map((s) => s.trim());
    for (const selector of selectors) {
      // Only simple selectors; descendant selectors ("a b") are ignored
      if (!selector || selector.includes(' ')) continue;
      if (scope === selector || scope.startsWith(`${selector}.`)) {
        if (!best || selector.length > best.length) best = { length: selector.length, color };
      }
    }
  }
  return best?.color;
}

function first(rules: TokenRule[], scopes: string[], fallback: string): string {
  for (const scope of scopes) {
    const color = scopeColor(rules, scope);
    if (color) return color;
  }
  return fallback;
}

/** Converts a VS Code colour theme (e.g. from "Developer: Generate Color Theme From Current Settings") */
export function fromVsCodeTheme(id: string, json: VsCodeThemeJson): Theme {
  const kind: Theme['kind'] = /light/i.test(json.type ?? '') ? 'light' : 'dark';
  const base = BUILTIN_THEMES.find((t) => t.id === (kind === 'light' ? 'light-plus' : 'dark-plus')) ?? BUILTIN_THEMES[0];
  const c = json.colors ?? {};
  const pick = (keys: string[], fallback: string) => keys.map((k) => c[k]).find(Boolean) ?? fallback;
  const rules = json.tokenColors ?? [];
  const fg = pick(['editor.foreground', 'foreground'], base.ui.fg);
  return {
    id,
    name: json.name ?? id,
    kind,
    ui: {
      bg: pick(['editor.background'], base.ui.bg),
      panel: pick(['sideBar.background', 'editorGroupHeader.tabsBackground', 'panel.background'], base.ui.panel),
      line: pick(['editorGroup.border', 'panel.border', 'sideBar.border', 'tab.border'], base.ui.line),
      fg,
      muted: pick(['editorLineNumber.foreground', 'descriptionForeground'], base.ui.muted),
      accent: pick(['focusBorder', 'button.background', 'textLink.foreground', 'activityBarBadge.background'], base.ui.accent),
      cursorLine: pick(['editor.lineHighlightBackground', 'editor.lineHighlightBorder'], base.ui.cursorLine),
    },
    tokens: {
      comment: first(rules, ['comment.line.double-slash', 'comment'], base.tokens.comment),
      keyword: first(rules, ['keyword.control', 'storage.type', 'keyword'], base.tokens.keyword),
      string: first(rules, ['string.quoted.double', 'string'], base.tokens.string),
      number: first(rules, ['constant.numeric'], base.tokens.number),
      type: first(rules, ['entity.name.type', 'support.type', 'entity.name.class', 'storage.type'], base.tokens.type),
      func: first(rules, ['entity.name.function', 'support.function'], base.tokens.func),
      punct: first(rules, ['punctuation', 'keyword.operator'], fg),
      variable: first(rules, ['variable.other', 'variable'], base.tokens.variable),
      literal: first(rules, ['constant.language', 'constant'], base.tokens.literal),
      attr: first(rules, ['meta.attribute', 'entity.other.attribute-name', 'support.function.macro', 'entity.name.function.macro'], base.tokens.attr),
    },
  };
}

/** Puts a theme into the CSS variables the stylesheet reads */
export function applyTheme(theme: Theme): void {
  const style = document.documentElement.style;
  const { ui, tokens } = theme;
  style.setProperty('--bg', ui.bg);
  style.setProperty('--bg-dark', ui.panel);
  style.setProperty('--line', ui.line);
  style.setProperty('--fg', ui.fg);
  style.setProperty('--muted', ui.muted);
  style.setProperty('--accent', ui.accent);
  style.setProperty('--cursor-line', ui.cursorLine);
  for (const [key, value] of Object.entries(tokens)) style.setProperty(`--tok-${key}`, value);
  // Status colours follow VS Code's git decorations for the theme's kind
  const status =
    theme.kind === 'light'
      ? { green: '#587c0c', yellow: '#895503', red: '#ad0707' }
      : { green: '#73c991', yellow: '#e2c08d', red: '#f48771' };
  for (const [key, value] of Object.entries(status)) style.setProperty(`--${key}`, value);
  document.documentElement.dataset.kind = theme.kind;
  style.colorScheme = theme.kind;
}
