import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// `app.getVersion()` reports Electron's version when the app runs unpackaged,
// so the real one is stamped in at build time instead.
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
const define = { __APP_VERSION__: JSON.stringify(version) };

const alias = {
  '@shared': resolve('src/shared'),
  '@core': resolve('src/core'),
  '@renderer': resolve('src/renderer'),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    define,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The CLI ships in the same bundle so `claudedeck` works headless.
          'cli/index': resolve('src/cli/index.ts'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // A sandboxed preload cannot be an ES module.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias },
    define,
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
  },
});
