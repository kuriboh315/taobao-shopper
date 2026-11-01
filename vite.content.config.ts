import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Content scripts can't be ES modules, so each one is built on its own as a self-contained IIFE:
//   vite build -c vite.content.config.ts --mode hook
//   vite build -c vite.content.config.ts --mode content
const root = import.meta.dirname;
const ENTRIES: Record<string, string> = {
  hook: 'src/collect/hook.ts',
  content: 'src/collect/content.ts',
};

export default defineConfig(({ mode }) => {
  const entry = ENTRIES[mode];
  if (!entry) throw new Error(`vite.content.config.ts: --mode must be one of ${Object.keys(ENTRIES).join(', ')}`);
  return {
    publicDir: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      outDir: resolve(root, 'dist'),
      emptyOutDir: false,
      target: 'es2022',
      minify: false,
      lib: {
        entry: resolve(root, entry),
        formats: ['iife'],
        name: `tbs_${mode}`,
        fileName: () => `${mode}.js`,
      },
    },
  };
});
