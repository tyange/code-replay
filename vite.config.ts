import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works under any GitHub Pages path
  base: './',
  resolve: {
    alias: {
      // monaco-editor's export map can't reach its CSS and contrib files, so point at the folder directly
      'monaco-vs': fileURLToPath(new URL('./node_modules/monaco-editor/esm/vs', import.meta.url)),
    },
  },
});
