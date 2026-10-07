import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { mango } from './src/vite.ts';

// The documentation site (site/): its pages are MangoScript modules compiled by the plugin from
// src/vite.ts. `npm run site:dev` serves it with Vite, `npm run site:build` builds it to site/dist.
// The English page is index.html, the Russian one ru/index.html.

const site = new URL('./site/', import.meta.url).pathname;

/** Folders of the examples of each language. */
const EXAMPLES: Record<string, string> = {
  en: join(site, 'examples'),
  ru: join(site, 'examples', 'ru'),
};

/**
 * `virtual:examples/en` and `virtual:examples/ru`: the code of the examples of a language by name.
 * It is part of the bundle, so the examples have their code, and their height, when the page is
 * first drawn. Loaded later, they would grow after the browser had scrolled to a link like
 * `#state`, and the text would jump.
 */
function examples(): Plugin {
  const prefix = 'virtual:examples/';
  return {
    name: 'mangoscript-examples',
    resolveId: (source) =>
      source.startsWith(prefix) && source.slice(prefix.length) in EXAMPLES ? `\0${source}` : null,
    load(id) {
      if (!id.startsWith(`\0${prefix}`)) return null;
      const dir = EXAMPLES[id.slice(prefix.length + 1)]!;
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.mango'))
        .sort();
      const code: Record<string, string> = {};
      for (const file of files) {
        const path = join(dir, file);
        this.addWatchFile(path);
        code[file.slice(0, -'.mango'.length)] = readFileSync(path, 'utf8').trimEnd();
      }
      return `export const EXAMPLES = ${JSON.stringify(code)};\n`;
    },
  };
}

export default defineConfig({
  root: site,
  // Relative paths to the assets: GitHub Pages serves the site from /<repository>/, and
  // site/server.mango from the root.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: { input: [join(site, 'index.html'), join(site, 'ru', 'index.html')] },
  },
  plugins: [mango(), examples()],
});
