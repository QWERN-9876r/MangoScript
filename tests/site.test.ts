import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/browser.ts';
import { build } from '../src/build.ts';

// The documentation site (site/) is a real MangoScript program: building it checks the compiler on
// real code. Its examples are compiled in the browser by src/browser.ts, so they are checked here
// with the same entry point.

const site = (path: string) => new URL(`../site/${path}`, import.meta.url).pathname;

describe('documentation site', () => {
  it('compiles without errors', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mango-site-'));
    const result = build([site('src'), site('server.mango')], { outDir });
    expect(result.errors.flatMap((error) => error.diagnostics)).toEqual([]);
    expect(result.outputs.map((output) => output.output.slice(outDir.length + 1)).sort()).toEqual([
      'server.js',
      'src/app.js',
      'src/example.js',
      'src/guide.js',
      'src/highlight.js',
      'src/playground.js',
      'src/sandbox.js',
    ]);
  });

  const examples = readdirSync(site('examples')).filter((name) => name.endsWith('.mango'));

  it.each(examples)('compiles the example %s in the browser compiler', (name) => {
    const result = compile(readFileSync(site(`examples/${name}`), 'utf8'));
    expect(result.diagnostics).toEqual([]);
    expect(result.code).not.toBe('');
  });

  it('uses every example and only existing ones', () => {
    const guide = readFileSync(site('src/guide.mango'), 'utf8');
    const used = [...guide.matchAll(/example\("([^"]+)"\)/g)].map((match) => `${match[1]}.mango`);
    expect(used.sort()).toEqual([...examples].sort());
  });

  it('reports errors with lines and columns', () => {
    expect(compile('let ok = true\nlet n number = "x"').diagnostics).toEqual([
      { message: 'cannot use string as number', line: 2, column: 16 },
    ]);
  });
});
