import { describe, expect, it } from 'vitest';
import { compile as compileInBrowser } from '../src/browser.ts';
import { compile } from '../src/index.ts';
import { errors as syntaxErrors, expr, sx } from './parser-helpers.ts';

// Typed arrays as slices of Go: `[]float64` is a Float64Array, `[]int64` a BigInt64Array, and
// `make([]float64, n)` makes one of `n` zeros, on a SharedArrayBuffer with `shared`.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
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

describe('the types', () => {
  it('are the typed arrays, made from a list or empty', () => {
    expect(
      js(`let a []float64 = [1, 2.5]
let b []int64 = [1n, 2n]
let c []int32
let d Float32Array
let e int64
let f uint8`),
    ).toBe(`let a = new Float64Array([1, 2.5]);
let b = new BigInt64Array([1n, 2n]);
let c = new Int32Array();
let d = new Float32Array();
let e = 0n;
let f = 0;
`);
  });

  it('take numbers, or bigints for the integers of 64 bits, and are written as in Go', () => {
    expect(
      errors(`let a []float64 = [1, 2]
const x float64 = a[0]
let b []uint64 = [1]
const s string = a
let bytes []byte = [...a]
let same Float64Array = a
let ok []uint8 = bytes`),
    ).toEqual([
      'cannot use number as bigint',
      'cannot use []float64 as string',
      'cannot spread []float64 into []byte',
    ]);
  });

  it('give way to a type of the same name', () => {
    expect(js('type float64 string\nlet names []float64')).toBe('let names = [];\n');
  });
});

describe('make', () => {
  it('reads a type, a length and the word shared', () => {
    expect(sx(expr('make([]float64, n + 1)'))).toBe('(make []float64 (+ n 1))');
    expect(sx(expr('make([]int32, 8, shared)'))).toBe('(make []int32 8 shared)');
    expect(sx(expr('make([1], 2)'))).toBe('(call make [1] 2)');
    expect(syntaxErrors('x = make([]float64, 4, other)')).toEqual([
      'the third argument of make is the word shared: make([]float64, n, shared)',
    ]);
  });

  it('makes a typed array of zeros', () => {
    expect(
      js(`const n = 4
const a = make([]float64, n)
const b = make([]uint8, n + 1, shared)
const c = make([]int64, n * 2, shared)`),
    ).toContain(`const a = new Float64Array(n);
const b = new Uint8Array($$shared(n + 1));
const c = new BigInt64Array($$shared(8 * (n * 2)));`);
    expect(
      run(
        js(`const a = make([]float64, 3)
a[1] = 0.5
const b = make([]int16, 2, shared)
console.log(a.join(" "), b.length, b.buffer instanceof SharedArrayBuffer)`),
      ),
    ).toEqual(['0 0.5 0 2 true']);
  });

  it('takes a typed array and a number', () => {
    expect(
      errors(`const a = make([]number, 3)
const b = make([]float64, "3")
const c = make(Float32Array, 3)`),
    ).toEqual([
      'make makes a typed array, e.g. make([]float64, n), not []number; a list starts empty and grows, e.g. let names []string = []',
      'cannot use string as number',
      'make takes the type of a typed array first, e.g. make([]float64, n)',
    ]);
  });

  it('works in the browser compiler', () => {
    const { code, diagnostics } = compileInBrowser(
      `const a = make([]float64, 2)
const x float64 = a[0]
let b []int64 = [1n]
const y bigint = b[0]`,
    );

    expect(diagnostics).toEqual([]);
    expect(code).toContain('const a = new Float64Array(2);');
  });
});
