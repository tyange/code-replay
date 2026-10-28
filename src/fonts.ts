export interface FontChoice {
  name: string;
  /** Loaded from Google Fonts when chosen; otherwise it must be installed on this computer */
  google?: boolean;
}

export const FONTS: FontChoice[] = [
  { name: 'JetBrains Mono', google: true },
  { name: 'Fira Code', google: true },
  { name: 'Source Code Pro', google: true },
  { name: 'IBM Plex Mono', google: true },
  { name: 'Roboto Mono', google: true },
  { name: 'Inconsolata', google: true },
  { name: 'Red Hat Mono', google: true },
  { name: 'Ubuntu Mono', google: true },
  { name: 'Space Mono', google: true },
  { name: 'Nanum Gothic Coding', google: true },
  { name: 'D2Coding' },
  { name: 'SF Mono' },
  { name: 'Menlo' },
  { name: 'Cascadia Code' },
  { name: 'Monaspace Neon' },
  { name: 'Consolas' },
];

export interface FontSettings {
  family: string;
  size: number;
  lineHeight: number;
  ligatures: boolean;
}

export const DEFAULT_FONT: FontSettings = { family: 'JetBrains Mono', size: 14, lineHeight: 1.6, ligatures: false };

const loaded = new Set<string>();

function loadGoogleFont(name: string): void {
  if (loaded.has(name)) return;
  loaded.add(name);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}&display=swap`;
  document.head.append(link);
}

/** CSS font-family value, with a Korean-capable fallback */
function stack(family: string): string {
  const name = family.trim().replace(/["\\]/g, '');
  return `${name ? `"${name}", ` : ''}"Nanum Gothic Coding", ui-monospace, Menlo, monospace`;
}

export function applyFont(font: FontSettings): void {
  if (FONTS.find((f) => f.name === font.family)?.google) loadGoogleFont(font.family);
  const style = document.documentElement.style;
  style.setProperty('--code-font', stack(font.family));
  style.setProperty('--code-size', `${font.size}px`);
  style.setProperty('--code-line', String(font.lineHeight));
  style.setProperty('--code-ligatures', font.ligatures ? 'normal' : 'none');
}
