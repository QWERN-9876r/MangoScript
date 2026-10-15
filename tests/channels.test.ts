import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';
import { errors as syntaxErrors, expr, first, sx, ty } from './parser-helpers.ts';

// Channels: `chan T`, `chan[T](size)`, `ch <- v`, `<-ch`, `for v in ch` and `close(ch)`. After
// close a channel gives the zero value of its type, as in Go.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
}

/** Runs a program in the main thread only; returns what it printed. */
async function run(source: string): Promise<string[]> {
  const output: string[] = [];
  const log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  const prototype = Object.getPrototypeOf(async () => {}) as { constructor: unknown };
  const AsyncFunction = prototype.constructor as new (
    ...args: string[]
  ) => (console: unknown) => Promise<void>;

  await new AsyncFunction('console', js(source))({ log });

  return output;
}

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

/** Builds a program with `mango build` and runs it with Node, with workers. */
function runBuilt(source: string): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mango-chan-'));
  const options = { cwd: dir, encoding: 'utf8' as const, timeout: 20_000 };

  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(dir, 'main.mango'), source);
  expect(spawnSync(process.execPath, [cli, 'build', 'main.mango'], options).stderr).toBe('');

  return spawnSync(process.execPath, ['main.js'], options);
}

describe('parsing', () => {
  it('reads channel types, making channels, receiving and sending', () => {
    const declaration = first('let c chan []number = chan[[]number](3)', 'VariableDeclaration');

    expect(ty(declaration.type!)).toBe('chan []number');
    expect(sx(declaration.values[0]!)).toBe('(chan []number 3)');
    expect(sx(expr('chan[string]()'))).toBe('(chan string)');
    expect(sx(expr('<-ch + 1'))).toBe('(+ (<- ch) 1)');
    expect(first('ch <- x * 2', 'SendStatement')).toMatchObject({ kind: 'SendStatement' });
    expect(syntaxErrors('<-done\nconst v, ok = <-ch\nfunc f(jobs chan number) {}')).toEqual([]);
  });

  it.each([
    ['func f() { <-ch }', '"<-" is allowed only in async functions'],
    ['func f() { ch <- 1 }', '"<-" is allowed only in async functions'],
    ['async func f() { defer { ch <- 1 } }', '"<-" is not allowed inside "defer"'],
    ['x = chan(1)', '"[": a channel is made as chan[T](size), e.g. chan[number](10)'],
  ])('reports %j', (source, message) => {
    expect(syntaxErrors(source)).toEqual([expect.stringContaining(message)]);
  });
});

describe('types', () => {
  it('types receiving: the zero value after close, or null where the type has none', () => {
    expect(
      errors(`interface Point { x, y number }
const numbers = chan[number](1)
const points = chan[Point](1)
const n number = <-numbers
const p Point = <-points
const q ?Point = <-points
const m, ok = <-numbers
const done bool = ok
const k number = m`),
    ).toEqual(['cannot use ?Point as Point: it may be null, check it first']);
  });

  it('checks what is sent and where', () => {
    expect(
      errors(`const ch = chan[number]()
ch <- 1
ch <- "x"
const n = 1
n <- 2
await ch
const v = <-n`),
    ).toEqual([
      'cannot use string as number',
      '"<-" sends to a channel, not to number',
      '"await" does not wait for a channel: receive from it, e.g. "<-ch"',
      '"<-" receives from a channel, not from number',
    ]);
  });

  it('keeps the type of the values exactly, as Go does', () => {
    expect(
      errors(`const a chan number = chan[number]()
const b chan ?number = a
const c chan number = chan[string](1)
close(a)
close(1)`),
    ).toEqual([
      'cannot use chan number as chan ?number',
      'cannot use chan string as chan number',
      expect.stringContaining('cannot use number as chan any'),
    ]);
  });

  it('checks loops over channels and the size', () => {
    expect(
      errors(`const ch = chan[string]("big")
func f(c chan number) {
    for v in c {}
}
async func g(c chan number) {
    for i, v in c {}
    for v in c {
        const s string = v
    }
}
let none chan number`),
    ).toEqual([
      'cannot use string as number',
      '"for ... in" a channel waits for its values, so it is allowed only in async functions and at the top level of a module',
      'a channel has no keys: write "for value in ch"',
      'cannot use number as string',
      expect.stringContaining('chan number has no zero value'),
    ]);
  });

  it('copies channels to workers only with values that can be copied', () => {
    expect(
      errors(`async func work(c chan number) {}
async func calls(c chan func()) {}
go work(chan[number]())
go calls(chan[func()]())`),
    ).toEqual([
      '"calls" runs in a worker, which gets a copy of argument 1, but a function cannot be copied',
    ]);
  });
});

describe('select', () => {
  it('parses receives, sends and default', () => {
    const [select] = first(
      'async func f() {\nselect {\ncase v, ok = <-a:\n    g(v)\ncase b <- 1:\ncase <-c:\ndefault:\n}\n}',
      'FuncDeclaration',
    ).body.body;

    expect(select?.kind === 'SelectStatement' && select.cases.map((c) => c.names.length)).toEqual([
      2, 0, 0, 0,
    ]);
    expect(syntaxErrors('const select = 1\nselect(x)')).toEqual([]);
  });

  it.each([
    ['func f() { select {} }', '"select" is allowed only in async functions'],
    [
      'select { case x: }',
      'a case of select receives, "case v = <-ch:", or sends, "case ch <- v:"',
    ],
    ['select { default:\ndefault: }', 'multiple "default" cases in select'],
    ['select { case a, b, c = <-ch: }', 'a receive gives at most two values'],
  ])('reports %j', (source, message) => {
    expect(syntaxErrors(source)).toEqual([expect.stringContaining(message)]);
  });

  it('types the variables of each case', () => {
    expect(
      errors(`const a = chan[number]()
const b = chan[string](1)
select {
case n, ok = <-a:
    const m number = n
    const done bool = ok
case s = <-b:
    const t number = s
case b <- 1:
}`),
    ).toEqual(['cannot use string as number', 'cannot use number as string']);
  });

  it('runs the case that can go on, default, or the first that can later', async () => {
    expect(
      await run(`const a = chan[number](1)
const b = chan[string](1)
const late = chan[string]()
select {
case n = <-a:
    console.log("a", n)
default:
    console.log("nothing")
}
b <- "x"
select {
case n = <-a:
    console.log("a", n)
case s = <-b:
    console.log("b", s)
}
select {
case a <- 7:
    console.log("sent", <-a)
default:
    console.log("full")
}
setTimeout(async () => {
    late <- "later"
}, 5)
select {
case s = <-late:
    console.log("late", s)
    break
    console.log("not after break")
case <-chan[number]():
    console.log("never")
}`),
    ).toEqual(['nothing', 'b x', 'sent 7', 'late later']);
  });
});

describe('code generation', () => {
  it('writes channels with the helpers of the main thread', () => {
    const code = js(`const ch = chan[number](2)
ch <- 1
const v = <-ch
const w, ok = <-ch
for x in ch {
    console.log(x)
}
close(ch)`);

    expect(code).toContain('const ch = $$chan(2, 0);');
    expect(code).toContain('await $$send(ch, 1);');
    expect(code).toContain('const v = await $$receive(ch);');
    expect(code).toContain('const [w, ok] = await $$receive(ch, true);');
    expect(code).toContain('for await (const x of $$range(ch)) {');
    expect(code).toContain('$$close(ch);');
    expect(code).toContain('const $$channels = Symbol.for("mangoscript.channels");');
  });

  it('asks the main thread in the worker module', () => {
    const { worker } = compile(`async func fill(c chan string) {
    c <- "x"
    close(c)
}
go fill(chan[string]())`);

    expect(worker).toContain(
      'function $$send(channel, value) {\n  $$retain(value);\n  return $$ask("send", channel, value);',
    );
    expect(worker).toContain('await $$send(c, "x");');
  });
});

// Processes with workers take seconds while the other tests run too.
describe('runtime', { timeout: 30_000 }, () => {
  it('passes values in the main thread: buffered, unbuffered and after close', async () => {
    expect(
      await run(`async func produce(out chan number) {
    for let i = 1; i <= 3; i++ {
        out <- i * 10
    }
    close(out)
}
const ch = chan[number]()
produce(ch)
let got []number
for v in ch {
    got.push(v)
}
console.log(got.join(" "))
const buffered = chan[string](2)
buffered <- "a"
buffered <- "b"
close(buffered)
const a, ok1 = <-buffered
const b, ok2 = <-buffered
const c, ok3 = <-buffered
console.log(a, ok1, b, ok2, c == "", ok3)`),
    ).toEqual(['10 20 30', 'a true b true true false']);
  });

  it('fails a send to a closed channel and a second close', async () => {
    expect(
      await run(`const ch = chan[number](1)
close(ch)
try {
    ch <- 1
} catch e {
    console.log(e.message)
}
try {
    close(ch)
} catch e {
    console.log(e.message)
}`),
    ).toEqual(['send on a closed channel', 'close of a closed channel']);
  });

  it('connects goroutines in workers through channels', () => {
    const { stdout, stderr } = runBuilt(`async func worker(jobs chan number, results chan number) {
    for n in jobs {
        results <- n * n
    }
}
async func produce(out chan number) {
    for let i = 1; i <= 4; i++ {
        out <- i
    }
    close(out)
}
async func sum(input chan number) number {
    let total = 0
    for n in input {
        total += n
    }
    return total
}
const jobs = chan[number](10)
const results = chan[number]()
go worker(jobs, results)
go worker(jobs, results)
for let n = 1; n <= 4; n++ {
    jobs <- n
}
close(jobs)
let squares []number
for let i = 0; i < 4; i++ {
    squares.push(<-results)
}
console.log(squares.sort((a, b) => a - b).join(" "))
const pipe = chan[number]()
go produce(pipe)
console.log(await go sum(pipe))
`);

    expect(stderr).toBe('');
    expect(stdout).toBe('1 4 9 16\n10\n');
  });
});
