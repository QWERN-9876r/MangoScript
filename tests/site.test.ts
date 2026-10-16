import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, complete } from '../src/browser.ts';
import { build } from '../src/build.ts';

// The documentation site (site/) is a real Rook program: building it checks the compiler on
// real code. Its examples are compiled in the browser by src/browser.ts, so they are checked here
// with the same entry point.

const site = (path: string) => new URL(`../site/${path}`, import.meta.url).pathname;

describe('documentation site', () => {
  it('compiles without errors', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'rook-site-'));
    const result = build([site('src'), site('server.rk')], { outDir });

    expect(result.errors.flatMap((error) => error.diagnostics)).toEqual([]);
    expect(result.outputs.map((output) => output.output.slice(outDir.length + 1)).sort()).toEqual([
      'server.js',
      'src/app.js',
      'src/en/guide-components.js',
      'src/en/guide-concurrency.js',
      'src/en/guide.js',
      'src/en/main.js',
      'src/en/strings.js',
      'src/example.js',
      'src/hero.js',
      'src/highlight-css.js',
      'src/highlight.js',
      'src/i18n.js',
      'src/playground.js',
      'src/ru/guide-components.js',
      'src/ru/guide-concurrency.js',
      'src/ru/guide.js',
      'src/ru/main.js',
      'src/ru/strings.js',
      'src/sandbox.js',
      // The RookUI kit, which the pages import.
      'ui/badge.js',
      'ui/button.js',
      'ui/callout.js',
      'ui/card.js',
      'ui/code-block.js',
      'ui/drawer.js',
      'ui/icon.js',
      'ui/nav-list.js',
      'ui/prose.js',
      'ui/tabs.js',
      'ui/theme.js',
    ]);
    expect(result.warnings).toEqual([]);
  }, 15_000);

  // English examples are in site/examples, Russian ones in site/examples/ru; the guide of a
  // language is guide.rk with the modules of its sections.
  const languages = [
    { language: 'en', examples: 'examples', guide: 'src/en' },
    { language: 'ru', examples: 'examples/ru', guide: 'src/ru' },
  ];
  const examplesOf = (dir: string) => readdirSync(site(dir)).filter((name) => name.endsWith('.rk'));
  const all = languages.flatMap(({ examples }) =>
    examplesOf(examples).map((name) => `${examples}/${name}`),
  );

  it.each(all)('compiles the example %s in the browser compiler', (path) => {
    const result = compile(readFileSync(site(path), 'utf8'), null, { markup: true });

    expect(result.diagnostics).toEqual([]);
    expect(result.code).not.toBe('');
  });

  it.each(languages)('uses every $language example and only existing ones', (language) => {
    const guide = readdirSync(site(language.guide))
      .filter((name) => name.startsWith('guide'))
      .map((name) => readFileSync(site(`${language.guide}/${name}`), 'utf8'))
      .join('\n');
    const used = [...guide.matchAll(/example\("([^"]+)"\)/g)].map((match) => `${match[1]}.rk`);

    expect(used.sort()).toEqual(examplesOf(language.examples).sort());
  });

  it('has every example and section in both languages', () => {
    expect(examplesOf('examples/ru').sort()).toEqual(examplesOf('examples').sort());

    const sections = (path: string) =>
      [...readFileSync(site(path), 'utf8').matchAll(/\{ id: "([^"]+)"/g)].map((match) => match[1]);

    expect(sections('src/ru/guide.rk')).toEqual(sections('src/en/guide.rk'));
  });

  it('reports errors with lines and columns of their start and end', () => {
    expect(compile('let ok = true\nlet n number = "x"').diagnostics).toEqual([
      { message: 'cannot use string as number', line: 2, column: 16, endLine: 2, endColumn: 19 },
    ]);
  });

  // The editor of the playground completes as the language server does.
  it('completes names in the browser compiler', () => {
    const source = 'const fruits = ["guava"]\nfruits.pu';
    const list = complete(source, source.length);

    expect(source.slice(list.start, list.end)).toBe('pu');
    expect(list.items).toContainEqual(expect.objectContaining({ name: 'push', kind: 'method' }));
  });
});
