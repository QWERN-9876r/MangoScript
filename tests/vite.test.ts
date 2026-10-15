import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { mango } from '../src/vite.ts';

// The Vite plugin (src/vite.ts) and the build of the documentation site with it.

const root = new URL('..', import.meta.url).pathname;

// Builds take seconds while the other tests run too.
describe('Vite plugin', { timeout: 30_000 }, () => {
  it('compiles .mango modules and the modules they import', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mango-vite-'));

    writeFileSync(join(dir, 'index.html'), '<script type="module" src="./main.mango"></script>');
    writeFileSync(
      join(dir, 'geom.mango'),
      'export func double(x number) number {\n    return x * 2\n}\n',
    );
    writeFileSync(
      join(dir, 'main.mango'),
      'import { double } from "./geom.mango"\nconsole.log(double(21))\n',
    );
    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [mango()],
      build: { outDir: join(dir, 'dist'), minify: false },
    });

    const assets = join(dir, 'dist', 'assets');
    const [bundle] = readdirSync(assets).filter((name) => name.endsWith('.js'));
    const code = readFileSync(join(assets, bundle!), 'utf8');

    expect(code).toContain('x * 2');
    // Both modules are in the bundle: no import of a .mango file is left.
    expect(code).not.toMatch(/from\s*"[^"]*\.mango"/);
  });

  it('bundles the worker module of go as a worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mango-vite-'));

    writeFileSync(join(dir, 'index.html'), '<script type="module" src="./main.mango"></script>');
    writeFileSync(
      join(dir, 'main.mango'),
      'func square(n number) number {\n    return n * n\n}\ndocument.body.append(`${await go square(3)}`)\n',
    );
    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [mango()],
      build: { outDir: join(dir, 'dist'), minify: false, target: 'esnext' },
    });

    const assets = join(dir, 'dist', 'assets');
    const files = readdirSync(assets);
    const worker = files.find((name) => name.startsWith('main.mango.goroutines'));
    const main = files.find((name) => name.startsWith('index'));

    expect(worker).toBeDefined();
    expect(readFileSync(join(assets, worker!), 'utf8')).toContain('function square(n)');
    expect(readFileSync(join(assets, worker!), 'utf8')).not.toContain('document.body');
    expect(readFileSync(join(assets, main!), 'utf8')).toContain(`/assets/${worker}`);
  });

  it('stops the build on type errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mango-vite-'));

    writeFileSync(join(dir, 'index.html'), '<script type="module" src="./main.mango"></script>');
    writeFileSync(join(dir, 'main.mango'), 'const n number = "one"\n');
    await expect(
      build({
        configFile: false,
        root: dir,
        logLevel: 'silent',
        plugins: [mango()],
        build: { outDir: join(dir, 'dist') },
      }),
    ).rejects.toThrow('main.mango:1:18: error: cannot use string as number');
  });
});

describe('documentation site', { timeout: 30_000 }, () => {
  it('is built by Vite: a page for each language, with its examples in its bundle', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mango-site-'));

    await build({
      configFile: join(root, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });

    const pages = [
      { html: 'index.html', prefix: './', examples: 'site/examples', other: 'site/examples/ru' },
      {
        html: 'ru/index.html',
        prefix: '../',
        examples: 'site/examples/ru',
        other: 'site/examples',
      },
    ];

    for (const page of pages) {
      const html = readFileSync(join(outDir, page.html), 'utf8');
      // Relative, so that the site works from any folder, as on GitHub Pages.
      const script = new RegExp(
        `src="${page.prefix.replace(/\./g, '\\.')}(assets/[^"]+\\.js)"`,
      ).exec(html)?.[1];

      expect(script, page.html).toBeDefined();

      const code = readFileSync(join(outDir, script!), 'utf8');
      // Examples are part of the bundle, not loaded after the page is drawn.
      const hello = (dir: string) =>
        JSON.stringify(readFileSync(join(root, dir, 'hello.mango'), 'utf8').trimEnd()).slice(1, 40);

      expect(code).toContain(hello(page.examples));
      expect(code).not.toContain(hello(page.other));
    }
  });
});
