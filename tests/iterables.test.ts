import { describe, expect, it } from 'vitest';
import { compile as compileInBrowser } from '../src/browser.ts';
import { compile } from '../src/index.ts';

// Types of the lib files that are indexed by position, as typed arrays are (`[index: number]: T`),
// and iterables, whose values `for ... in` takes from `[Symbol.iterator]()`. A Map gives its keys
// and values, as a map in Go; one variable gets the values, as with an array.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

/** Runs compiled code; returns what it printed. */
function run(code: string): string[] {
  const output: string[] = [];
  const log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const program = new Function('console', code) as (console: { log: typeof log }) => void;

  program({ log });

  return output;
}

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
}

describe('typed arrays', () => {
  it('are indexed by position, and are array-like', () => {
    expect(
      errors(`const data = new Float64Array(3)
data[1] = 2
const a number = data[1]
const b string = data[0]
const c = data["x"]
const copy []number = Array.from(data)`),
    ).toEqual(['cannot use number as string', 'index must be a number, not string']);
  });

  it('give their values, and positions with two variables', () => {
    expect(
      run(
        js(`const data = new Uint8Array(3)
data[1] = 7
for v in data {
    console.log(v)
}
for i, v in data {
    const position number = i
    console.log(position, v)
}`),
      ),
    ).toEqual(['0', '7', '0', '0 0', '1 7', '2 0']);
  });
});

describe('iterables', () => {
  const scores = `const scores Map<string, number> = new Map()
scores.set("ann", 3).set("bob", 5)
`;

  it('loop over a Map by its keys and values, or its values', () => {
    const code = js(`${scores}for name, score in scores {
    const key string = name
    console.log(key, score)
}
for score in scores {
    const total number = score
    console.log(total)
}`);

    expect(code).toContain('for (const [name, score] of scores.entries()) {');
    expect(code).toContain('for (const score of scores.values()) {');
    expect(run(code)).toEqual(['ann 3', 'bob 5', '3', '5']);
  });

  it('loop over a Set by its values, which have no keys', () => {
    expect(
      errors(`const tags Set<string> = new Set()
for tag in tags {
    const upper string = tag.toUpperCase()
}
for i, tag in tags {
}`),
    ).toEqual(['Set<string> has no keys: loop over its values, e.g. "for value in items"']);
  });

  it('tell a Map at runtime when its type is unknown', () => {
    const { code, diagnostics } = compileInBrowser(`const scores = new Map()
scores.set("ann", 3)
for score in scores {
    console.log(score)
}
for item in [1, 2] {
    console.log(item)
}`);

    expect(diagnostics).toEqual([]);
    expect(code).toContain('for (const score of $$values(scores)) {');
    expect(code).toContain('for (const item of [1, 2]) {');
    expect(run(code)).toEqual(['3', '1', '2']);
  });
});
