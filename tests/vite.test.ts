import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { mango } from '../src/vite.ts';

// The Vite plugin (src/vite.ts) and the build of the documentation site with it.

const root = new URL('..', import.meta.url).pathname;

describe('Vite plugin', () => {
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

describe('documentation site', () => {
  it('is built by Vite with the code of the examples in the bundle', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mango-site-'));
    await build({
      configFile: join(root, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    // Relative, so that the site works from any folder, as on GitHub Pages.
    const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(script).toBeDefined();
    const code = readFileSync(join(outDir, script!), 'utf8');
    // Examples are part of the bundle, not loaded after the page is drawn.
    const hello = readFileSync(join(root, 'site/examples/hello.mango'), 'utf8').trimEnd();
    expect(code).toContain(JSON.stringify(hello).slice(1, 40));
    expect(code).not.toContain('/examples/');
  });
});
