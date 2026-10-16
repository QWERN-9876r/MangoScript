import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { rook } from '../src/vite.ts';

// The Vite plugin (src/vite.ts) and the build of the documentation site with it.

const root = new URL('..', import.meta.url).pathname;

// Builds take seconds while the other tests run too.
describe('Vite plugin', { timeout: 30_000 }, () => {
  it('compiles .rk modules and the modules they import', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rook-vite-'));

    writeFileSync(join(dir, 'index.html'), '<script type="module" src="./main.rk"></script>');
    writeFileSync(
      join(dir, 'geom.rk'),
      'export func double(x number) number {\n    return x * 2\n}\n',
    );
    writeFileSync(
      join(dir, 'main.rk'),
      'import { double } from "./geom.rk"\nconsole.log(double(21))\n',
    );
    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [rook()],
      build: { outDir: join(dir, 'dist'), minify: false },
    });

    const assets = join(dir, 'dist', 'assets');
    const [bundle] = readdirSync(assets).filter((name) => name.endsWith('.js'));
    const code = readFileSync(join(assets, bundle!), 'utf8');

    expect(code).toContain('x * 2');
    // Both modules are in the bundle: no import of a .rk file is left.
    expect(code).not.toMatch(/from\s*"[^"]*\.rk"/);
  });

  it('bundles the worker module of go as a worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rook-vite-'));

    writeFileSync(join(dir, 'index.html'), '<script type="module" src="./main.rk"></script>');
    writeFileSync(
      join(dir, 'main.rk'),
      'func square(n number) number {\n    return n * n\n}\ndocument.body.append(`${await go square(3)}`)\n',
    );
    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [rook()],
      build: { outDir: join(dir, 'dist'), minify: false, target: 'esnext' },
    });

    const assets = join(dir, 'dist', 'assets');
    const files = readdirSync(assets);
    const worker = files.find((name) => name.startsWith('main.rk.goroutines'));
    const main = files.find((name) => name.startsWith('index'));

    expect(worker).toBeDefined();
    expect(readFileSync(join(assets, worker!), 'utf8')).toContain('function square(n)');
    expect(readFileSync(join(assets, worker!), 'utf8')).not.toContain('document.body');
    expect(readFileSync(join(assets, main!), 'utf8')).toContain(`/assets/${worker}`);
  });

  it('stops the build on type errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rook-vite-'));

    writeFileSync(join(dir, 'index.html'), '<script type="module" src="./main.rk"></script>');
    writeFileSync(join(dir, 'main.rk'), 'const n number = "one"\n');
    await expect(
      build({
        configFile: false,
        root: dir,
        logLevel: 'silent',
        plugins: [rook()],
        build: { outDir: join(dir, 'dist') },
      }),
    ).rejects.toThrow('main.rk:1:18: error: cannot use string as number');
  });
});

describe('documentation site', { timeout: 30_000 }, () => {
  it('is built by Vite: the pages of each language, the guide with its examples', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'rook-site-'));

    await build({
      configFile: join(root, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });

    for (const html of ['playground/index.html', 'ru/index.html', 'ru/playground/index.html']) {
      expect(readFileSync(join(outDir, html), 'utf8')).toMatch(/src="(\.\.\/)+assets\/[^"]+\.js"/);
    }

    const guides = [
      {
        html: 'docs/index.html',
        prefix: '../',
        examples: 'site/examples',
        other: 'site/examples/ru',
      },
      {
        html: 'ru/docs/index.html',
        prefix: '../../',
        examples: 'site/examples/ru',
        other: 'site/examples',
      },
    ];

    for (const guide of guides) {
      const html = readFileSync(join(outDir, guide.html), 'utf8');
      // Relative, so that the site works from any folder, as on GitHub Pages; the script of the
      // page and the chunks it imports at once, which Vite preloads.
      const scripts = [
        ...html.matchAll(
          new RegExp(`"${guide.prefix.replace(/\./g, '\\.')}(assets/[^"]+\\.js)"`, 'g'),
        ),
      ].map((match) => match[1]!);

      expect(scripts.length, guide.html).toBeGreaterThan(0);

      const code = scripts.map((script) => readFileSync(join(outDir, script), 'utf8')).join('\n');
      // Examples are part of the bundle, not loaded after the page is drawn.
      const hello = (dir: string) =>
        JSON.stringify(readFileSync(join(root, dir, 'hello.rk'), 'utf8').trimEnd()).slice(1, 40);

      expect(code).toContain(hello(guide.examples));
      expect(code).not.toContain(hello(guide.other));
    }
  });
});
