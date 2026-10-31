import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = import.meta.dirname;
const dist = resolve(root, 'dist');

/** Copies the manifest and flattens panel/options HTML to the dist root. */
function extensionFiles(): Plugin {
  return {
    name: 'extension-files',
    closeBundle() {
      mkdirSync(dist, { recursive: true });
      copyFileSync(resolve(root, 'src/manifest.json'), resolve(dist, 'manifest.json'));
      // Vite emits HTML at dist/<dir>/<name>.html; the manifest expects them at the dist root.
      for (const name of ['panel', 'options']) {
        const from = resolve(dist, name, `${name}.html`);
        if (!existsSync(from)) continue;
        const html = readFileSync(from, 'utf8').replaceAll('../assets/', './assets/');
        writeFileSync(resolve(dist, `${name}.html`), html);
        rmSync(resolve(dist, name), { recursive: true, force: true });
      }
    },
  };
}

const stableNames: Record<string, string> = {
  background: 'background.js',
  hook: 'hook.js',
  content: 'content.js',
};

export default defineConfig({
  root: resolve(root, 'src'),
  base: './',
  publicDir: false,
  plugins: [extensionFiles()],
  build: {
    outDir: dist,
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      input: {
        background: resolve(root, 'src/background/index.ts'),
        hook: resolve(root, 'src/collect/hook.ts'),
        content: resolve(root, 'src/collect/content.ts'),
        panel: resolve(root, 'src/panel/panel.html'),
        options: resolve(root, 'src/options/options.html'),
      },
      output: {
        entryFileNames: (chunk) => stableNames[chunk.name] ?? 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
