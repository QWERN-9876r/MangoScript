import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile as compileInBrowser } from '../src/browser.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';

// Markup and components are off unless the package turns them on, with "rook":
// { "markup": true } in its package.json, or the CLI and the Vite plugin for all files. So
// Rook can be the language of the logic of an app whose views are in React or Vue.

const cli = new URL('../src/cli.ts', import.meta.url).pathname;
const OFF = (what: string) =>
  `${what} off: turn on markup and components with "rook": { "markup": true } in package.json, or with --markup`;

function offErrors(source: string): string[] {
  return parse(source, { markup: false }).diagnostics.map((d) => d.message);
}

/** A project with a package.json, and a module in it. */
function project(settings: object | null, source: string, subdir = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'rook-markup-'));

  if (settings) writeFileSync(join(dir, 'package.json'), JSON.stringify(settings));
  mkdirSync(join(dir, subdir), { recursive: true });

  const filename = join(dir, subdir, 'app.rk');

  writeFileSync(filename, source);

  return filename;
}

const ELEMENT = 'const title = <h1>Hello</h1>';

describe('markup and components turned off', () => {
  it('are errors that say how to turn them on', () => {
    expect(offErrors(ELEMENT)).toEqual([OFF('markup is')]);
    expect(offErrors('comp Card() {\n    return <p />\n}')).toEqual([OFF('components are')]);
    expect(offErrors('export comp Card() {\n}')).toEqual([OFF('components are')]);
    expect(offErrors('let page comp()')).toEqual([OFF('components are')]);
    expect(offErrors('dec logged() {\n}')).toEqual([OFF('decorators are')]);
    expect(offErrors('@html-tag("app-card")\ncomp Card() {\n}')).toEqual([
      OFF('decorators are'),
      OFF('components are'),
    ]);
  });

  it('leave the rest of the language as it is', () => {
    expect(
      offErrors(`const ch = chan<number>(1)
const less = 1 < 2
let state = 0
const ref = "x"
func dec(effect number) number {
    return effect
}
async func read() {
    const v = <-ch
}`),
    ).toEqual([]);
  });
});

describe('the setting', () => {
  it('comes from the nearest package.json, off without the field', () => {
    expect(
      compile(ELEMENT, { filename: project({ rook: { markup: true } }, ELEMENT) }).diagnostics,
    ).toEqual([]);
    expect(
      compile(ELEMENT, {
        filename: project({ rook: { markup: true } }, ELEMENT, 'src/views'),
      }).diagnostics,
    ).toEqual([]);
    expect(
      compile(ELEMENT, { filename: project({ name: 'app' }, ELEMENT) }).diagnostics.map(
        (d) => d.message,
      ),
    ).toEqual([OFF('markup is')]);
  });

  it('is given for all files by an option, over package.json', () => {
    const on = project({ rook: { markup: true } }, ELEMENT);
    const off = project({ name: 'app' }, ELEMENT);

    expect(compile(ELEMENT, { filename: on, markup: false }).diagnostics).toHaveLength(1);
    expect(compile(ELEMENT, { filename: off, markup: true }).diagnostics).toEqual([]);
  });

  it('is off in the browser compiler unless it is asked for', () => {
    expect(compileInBrowser(ELEMENT).diagnostics.map((d) => d.message)).toEqual([OFF('markup is')]);
    expect(compileInBrowser(ELEMENT, null, { markup: true }).diagnostics).toEqual([]);
  });

  it('is given to the CLI with --markup and --no-markup', () => {
    const file = project({ name: 'app' }, `${ELEMENT}\nconsole.log(typeof title)`);
    const rook = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args, file], { encoding: 'utf8' });

    expect(rook('build', '--stdout').stderr).toContain('markup is off');
    expect(rook('build', '--stdout', '--markup').stdout).toContain('createElement("h1")');
    expect(rook('build', '--stdout', '--markup', '--no-markup').stderr).toContain(
      '--markup and --no-markup cannot be used together',
    );

    const on = project({ rook: { markup: true } }, ELEMENT);

    expect(
      spawnSync(process.execPath, [cli, 'build', '--stdout', '--no-markup', on], {
        encoding: 'utf8',
      }).stderr,
    ).toContain('markup is off');
  });
});
