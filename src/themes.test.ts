import { describe, expect, it } from 'vitest';
import { fromVsCodeTheme, parseJsonc, type VsCodeThemeJson } from './themes';

describe('VS Code themes', () => {
  it('reads JSON with comments and trailing commas', () => {
    const json = parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1, 2,],\n}');
    expect(json).toEqual({ a: 'http://x', b: [1, 2] });
  });

  it('maps editor colours and the most specific token rule', () => {
    const theme: VsCodeThemeJson = {
      name: 'Mine',
      type: 'light',
      colors: { 'editor.background': '#fafafa', 'editor.foreground': '#111111' },
      tokenColors: [
        { scope: 'comment', settings: { foreground: '#aaaaaa' } },
        { scope: ['keyword', 'storage.type'], settings: { foreground: '#0000aa' } },
        { scope: 'keyword.control', settings: { foreground: '#aa00aa' } },
        { scope: 'string, constant.numeric', settings: { foreground: '#00aa00' } },
        { scope: 'source.rust comment', settings: { foreground: '#ff0000' } },
      ],
    };
    const result = fromVsCodeTheme('mine', theme);
    expect(result.kind).toBe('light');
    expect(result.ui.bg).toBe('#fafafa');
    expect(result.tokens.comment).toBe('#aaaaaa');
    expect(result.tokens.keyword).toBe('#aa00aa');
    expect(result.tokens.string).toBe('#00aa00');
    expect(result.tokens.number).toBe('#00aa00');
    // Missing ones fall back to Light+
    expect(result.tokens.func).toBe('#795e26');
  });
});
