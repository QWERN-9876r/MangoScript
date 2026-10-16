import { describe, expect, it } from 'vitest';
import { compile as compileInBrowser } from '../src/browser.ts';
import { compile } from '../src/index.ts';
import { tokenize } from '../src/lexer/lexer.ts';
import { expr } from './parser-helpers.ts';

// bigint: whole numbers of any size, `10n`, as in JS. They do not mix with numbers in arithmetic,
// where JS throws, and `==` between the two, which is `===`, would always be false.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

/** Runs compiled code; returns what it printed. */
function run(source: string): string[] {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  const output: string[] = [];
  const log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const program = new Function('console', code) as (console: { log: typeof log }) => void;

  program({ log });

  return output;
}

describe('bigint literals', () => {
  it('are read as written, in any base and with separators', () => {
    const { tokens } = tokenize('10n 0xffn 0b101n 0o17n 1_000_000n');

    expect(tokens.filter((token) => token.kind === 'BigInt').map((token) => token.text)).toEqual([
      '10n',
      '0xffn',
      '0b101n',
      '0o17n',
      '1_000_000n',
    ]);
    expect(expr('12345678901234567890n')).toMatchObject({
      kind: 'BigIntLiteral',
      raw: '12345678901234567890n',
    });
  });

  it('are whole numbers', () => {
    expect(tokenize('1.5n').diagnostics.map((d) => d.message)).toEqual([
      'a bigint is a whole number, without a fraction or an exponent: e.g. 1n',
    ]);
    expect(tokenize('1e3n').diagnostics).toHaveLength(1);
    expect(tokenize('10m').diagnostics.map((d) => d.message)).toEqual([
      'identifier cannot start immediately after a number',
    ]);
  });
});

describe('the bigint type', () => {
  it('computes with bigints and compares them with numbers', () => {
    expect(
      run(`let big = 2n ** 64n
let zero bigint
big += 1n
big++
const half = -big / 2n
const less bool = 1n < 2
console.log(big, zero, half, less, typeof big, 0xffn & 0x0fn, 1n << 10n)
console.log(big.toString(16), BigInt(42) * 3n, Number(7n) + 1, BigInt.asUintN(8, 257n))
console.log(\`\${big}\`, big == 18446744073709551618n)`),
    ).toEqual([
      '18446744073709551618 0 -9223372036854775809 true bigint 15 1024',
      '10000000000000002 126 8 1',
      '18446744073709551618 true',
    ]);
  });

  it('does not mix with numbers', () => {
    expect(
      errors(`let a = 10n
const b = a + 1
const c = 2 * a
const d = a == 10
const e = +a
const f = a >>> 1n
let g number = a
let h bigint = 1
if a { }`),
    ).toEqual([
      'cannot mix bigint and number in "+": convert one of them, e.g. BigInt(n) or Number(b)',
      'cannot mix bigint and number in "*": convert one of them, e.g. BigInt(n) or Number(b)',
      'cannot compare bigint and number with "==", it is always false: convert one of them, e.g. BigInt(n) or Number(b)',
      '"+" does not work with bigint: use Number(b)',
      '">>>" does not work with bigint: use ">>"',
      'cannot use bigint as number',
      'cannot use number as bigint',
      'condition must be bool, not bigint: compare it, e.g. "n != 0n"',
    ]);
  });

  it('is narrowed by typeof and goes into markup and to workers', () => {
    expect(
      errors(`func show(x number | bigint) string {
    if typeof x == "bigint" {
        const b bigint = x
        return b.toString()
    }
    return x.toFixed(2)
}
func count() bigint {
    return 5n
}
const p = go count()
const label = <span>{10n}</span>`),
    ).toEqual([]);
  });

  it('is known in the browser and in the types of the lib files', () => {
    expect(
      compileInBrowser('let a bigint = BigInt("9007199254740993")\nlet b = a * 2n').diagnostics,
    ).toEqual([]);
    expect(
      errors(`const view = new DataView(new ArrayBuffer(8))
const n bigint = view.getBigInt64(0)
const m number = view.getBigUint64(0)`),
    ).toEqual(['cannot use bigint as number']);
  });
});
