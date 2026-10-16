import { describe, expect, it } from 'vitest';
import { compile as compileInBrowser } from '../src/browser.ts';
import { compile } from '../src/index.ts';
import { errors as syntaxErrors, expr, sx } from './parser-helpers.ts';

// `[]byte` is a Uint8Array, as a byte slice in Go, and `byte` a number from 0 to 255. Text and its
// UTF-8 bytes convert as in Go: `[]byte("guava")` and `string(data)`.

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

describe('[]byte', () => {
  it('is a Uint8Array, from a list of numbers or empty', () => {
    expect(
      js(`let data []byte = [104, 105]
let empty []byte
const copy = [...data, 33]`),
    ).toBe(`let data = new Uint8Array([104, 105]);
let empty = new Uint8Array();
const copy = [...data, 33];
`);
    expect(
      run(
        js(`let data []byte = [104, 105, 0]
data[2] = 33
let empty []byte
const first byte = data[0]
for i, b in data {
    console.log(i, b)
}
console.log(first, data.length, empty.length, data instanceof Uint8Array)`),
      ),
    ).toEqual(['0 104', '1 105', '2 33', '104 3 0 true']);
  });

  it('converts to text and back in UTF-8', () => {
    expect(expr('[]byte("guava")')).toMatchObject({ kind: 'ConversionExpression' });
    expect(sx(expr('[]byte(name + "!")'))).toBe('([]byte (+ name "!"))');
    expect(syntaxErrors('const b = []byte')).toEqual([
      'expected "(" after the type: e.g. []byte("text") gives the bytes of a string, found newline',
    ]);
    expect(
      run(
        js(`const bytes = []byte("ладья")
const text string = string(bytes)
console.log(bytes.length, text, string([]byte("ok")))`),
      ),
    ).toEqual(['10 ладья ok']);
  });

  it('checks what goes in and out', () => {
    expect(
      errors(`let data []byte = [1, "a"]
const numbers []number = data
const a = []byte(42)
const b = string(5)
const c = string()
const d = []number("1")`),
    ).toEqual([
      'cannot use string as number',
      'cannot use []byte as []number',
      '[]byte(...) gives the UTF-8 bytes of a string, not of number; bytes are written as a list, e.g. let data []byte = [1, 2]',
      'string(...) turns []byte into text, not number; for other values use String(x) or a template string, e.g. `${x}`',
      'string(...) takes one []byte, e.g. string(data)',
      'cannot convert to []number: only []byte("text") and string(bytes) convert between types; for other values call a function, e.g. Number(s)',
    ]);
  });

  it('gives way to names that the program declares', () => {
    expect(
      run(
        js(`type byte string
let names []byte
func string(n number) number {
    return n * 2
}
console.log(names.length, string(21))`),
      ),
    ).toEqual(['0 42']);
  });

  it('works in the browser compiler and goes to workers', () => {
    const { diagnostics, code } = compileInBrowser(`let data []byte = [1, 2]
const text = string(data)
const n number = data[0]
const s string = data[1]
func sum(bytes []byte) number {
    return bytes.length
}
const total = go sum(transfer(data))`);

    expect(diagnostics.map((d) => d.message)).toEqual(['cannot use number as string']);
    expect(code).toBe('');
    expect(compileInBrowser('let data []byte = [1]\nconsole.log(data)').code).toContain(
      'new Uint8Array([1])',
    );
  });
});
