import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { mango } from './src/vite.ts';

// The documentation site (site/): its pages are MangoScript modules compiled by the plugin from
// src/vite.ts. `npm run site:dev` serves it with Vite, `npm run site:build` builds it to site/dist.

const site = new URL('./site/', import.meta.url).pathname;
const examplesDir = join(site, 'examples');

/**
 * `virtual:examples`: the code of site/examples/*.mango by name. It is part of the bundle, so the
 * examples have their code, and their height, when the page is first drawn. Loaded later, they
 * would grow after the browser had scrolled to a link like `#state`, and the text would jump.
 */
function examples(): Plugin {
  const id = 'virtual:examples';
  const resolved = `\0${id}`;
  return {
    name: 'mangoscript-examples',
    resolveId: (source) => (source === id ? resolved : null),
    load(loadId) {
      if (loadId !== resolved) return null;
      const files = readdirSync(examplesDir)
        .filter((name) => name.endsWith('.mango'))
        .sort();
      const code: Record<string, string> = {};
      for (const file of files) {
        const path = join(examplesDir, file);
        this.addWatchFile(path);
        code[file.slice(0, -'.mango'.length)] = readFileSync(path, 'utf8').trimEnd();
      }
      return `export const EXAMPLES = ${JSON.stringify(code)};\n`;
    },
  };
}

export default defineConfig({
  root: site,
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [mango(), examples()],
});
