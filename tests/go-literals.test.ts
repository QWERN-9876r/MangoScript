import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';

// `go func(x) { ... }(y)`: a function literal in a worker, which gets copies of the local names it
// uses; and `transfer(x)`, which moves a buffer to the thread it goes to instead of copying it.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

/** Builds a program, with or without checking its types, and runs it with Node. */
function run(source: string, check = true): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rook-literal-'));
  const options = { cwd: dir, encoding: 'utf8' as const, timeout: 20_000 };
  const flags = check ? [] : ['--no-check'];

  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(dir, 'main.rk'), source);
  expect(spawnSync(process.execPath, [cli, 'build', ...flags, 'main.rk'], options).stderr).toBe('');

  return spawnSync(process.execPath, ['main.js'], options);
}

const squares = `const LIMIT = 3
func square(n number) number {
    return n * n
}
async func run(factor number) []number {
    const results = chan<number>(LIMIT)
    for let i = 1; i <= LIMIT; i++ {
        go async func(n number) {
            results <- square(n) * factor
        }(i)
    }
    const all []number = []
    for let i = 1; i <= LIMIT; i++ {
        all.push(<-results)
    }
    return all.sort((a, b) => a - b)
}
console.log(await run(10))
const doubled = await go async func(xs []number) []number {
    const inner = go func() number {
        return xs.length
    }()
    return [...xs.map(x => x * 2), await inner]
}([1, 2, 3])
console.log(doubled)
`;

describe('go with a function literal', () => {
  it('copies the local names it uses, which must be data and stay unchanged there', () => {
    expect(
      errors(`let counter = 0
func run() {
    let total = 0
    const log = (x number) => console.log(x)
    go func() {
        total += 1
        log(total)
        counter++
    }()
    go (() => 1)()
}`),
    ).toEqual([
      'the goroutine runs in a worker, which gets a copy of "total", so changing it there does not change it here; send the new value through a channel or return it',
      'the goroutine runs in a worker, which gets a copy of "log", but a function cannot be copied',
      'the goroutine runs in a worker, which does not share the variables of the module, but its code uses "counter"; pass the value as an argument, or make it a const',
      '"go" calls a function declared at the top level of a module or imported, or a function literal: a worker has only those, e.g. "go work(x)" or "go func() { ... }()"',
    ]);
  });

  it('becomes a function of the worker module that gets the local names first', () => {
    const { code, worker, diagnostics } = compile(squares);

    expect(diagnostics).toEqual([]);
    expect(code).toContain('$$go("$$goroutine0", [results, factor, i]);');
    expect(worker).toContain('async function $$goroutine0(results, factor, n) {');
    expect(worker).toContain('function square(n) {');
    // In the worker, a literal runs in the same worker.
    expect(worker).toContain('const inner = $$go((xs) => {');
  });

  it('runs in workers, also nested and without checking the types', { timeout: 30_000 }, () => {
    for (const check of [true, false]) {
      const { stdout, stderr } = run(squares, check);

      expect(stderr).toBe('');
      expect(stdout).toBe('[ 10, 40, 90 ]\n[ 2, 4, 6, 3 ]\n');
    }
  });
});

describe('transfer', () => {
  it('takes a buffer or a typed array', () => {
    expect(
      errors(`const bytes = transfer(new Uint8Array(4))
const buffer ArrayBuffer = transfer(new ArrayBuffer(8))
const text = transfer("text")`),
    ).toEqual([
      'transfer() moves an ArrayBuffer or a typed array to another thread, not string; other values are copied',
    ]);
  });

  it('moves the buffer to a worker and back', { timeout: 30_000 }, () => {
    const { stdout, stderr } = run(`func total(data Float64Array) Float64Array {
    const sum = data.reduce((a, b) => a + b, 0)
    return transfer(data.fill(sum, 0, 1))
}
const data = new Float64Array(1000).fill(1)
const pending = go total(transfer(data))
console.log(data.length)
const back = await pending
console.log(back.at(0), back.length)
const kept = new Float64Array(10)
await go total(kept)
console.log(kept.length)
`);

    expect(stderr).toBe('');
    expect(stdout).toBe('0\n1000 1000\n10\n');
  });
});
