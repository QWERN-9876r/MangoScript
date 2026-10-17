import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from '../src/build.ts';
import { compile } from '../src/index.ts';
import { mountWithDom } from './fake-dom.ts';
import { errors as syntaxErrors, expr, first, sx, ty } from './parser-helpers.ts';

// Queues: `queue T`, made by `queue<T>()` or `queue<T>(items)`, with the methods of an array that
// a queue keeps; `shift()` and `unshift()` do not move the other values.

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

/** Builds a program with `rook build` and runs it with Node, with workers. */
function runBuilt(source: string): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rook-queue-'));
  const options = { cwd: dir, encoding: 'utf8' as const, timeout: 20_000 };

  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(dir, 'main.rk'), source);
  expect(spawnSync(process.execPath, [cli, 'build', 'main.rk'], options).stderr).toBe('');

  return spawnSync(process.execPath, ['main.js'], options);
}

describe('parsing', () => {
  it('reads queue types and making queues', () => {
    const declaration = first('let q queue []number = queue<[]number>([])', 'VariableDeclaration');

    expect(ty(declaration.type!)).toBe('queue []number');
    expect(sx(declaration.values[0]!)).toBe('(queue []number [])');
    expect(sx(expr('queue<string>()'))).toBe('(queue string)');
    expect(sx(expr('queue<queue number>()'))).toBe('(queue queue number)');
    expect(sx(expr('queue<chan<- number>()'))).toBe('(queue chan<- number)');
    expect(ty(first('let q queue ?(string | number)', 'VariableDeclaration').type!)).toBe(
      'queue ?(string | number)',
    );
  });

  it('keeps queue a name elsewhere', () => {
    expect(sx(expr('queue < 2'))).toBe('(< queue 2)');
    expect(sx(expr('queue < 2 >> 1'))).toBe('(< queue (>> 2 1))');
    expect(sx(expr('queue.length'))).toBe('(. queue length)');
    expect(ty(first('let q queue', 'VariableDeclaration').type!)).toBe('queue');
    expect(syntaxErrors('const queue = 1\nconsole.log(queue < 2, queue)')).toEqual([]);
  });

  it('wants one argument', () => {
    expect(syntaxErrors('const q = queue<number>([1], [2])')).toEqual([
      'expected ")": a queue takes its first values as one array, e.g. queue<number>([1, 2]), found "["',
    ]);
  });
});

describe('checking', () => {
  it('types the members', () => {
    expect(
      errors(`const q = queue<number>([1, 2])
const n number = q.length + q.push(3, 4) + q.unshift(0)
const a ?number = q.shift()
const b ?number = q.pop()
const c ?number = q.at(-1)
q.clear()
for v in q {
    const x number = v
}
const all []number = [...q]`),
    ).toEqual([]);
  });

  it.each([
    ['const q = queue<number>()\nq.push("a")', 'cannot use string as number in argument 1'],
    [
      'const q = queue<number>()\nconst n number = q.shift()',
      'cannot use ?number as number: it may be null, check it first',
    ],
    ['let q queue number = [1, 2]', 'cannot use []number as queue number'],
    ['let xs []number = queue<number>()', 'cannot use queue number as []number'],
    ['let a = queue<number>()\nlet b queue string = a', 'cannot use queue number as queue string'],
    [
      'const q = queue<number>(5)',
      'queue<T>(items) takes its first values as an array or another iterable, not number, e.g. queue<number>([1, 2, 3])',
    ],
    ['const q = queue<number>(["a"])', 'cannot use string as number'],
    [
      'let q queue<number>',
      'a queue type is written with the type of its values after it, e.g. "queue number"',
    ],
    [
      'const q = queue<number>()\nfor i, v in q { }',
      'queue number has no keys: loop over its values, e.g. "for value in items"',
    ],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });

  it('takes the values of another iterable and gives a queue where an interface is expected', () => {
    expect(
      errors(`const q = queue<number>(queue<number>([1]))
const r = queue<?number>([1, null])
let more queue ?number = q
interface Sized { length number }
const s Sized = q`),
    ).toEqual([]);
  });

  it('copies a queue to a worker if its values can be copied', () => {
    expect(
      errors(`class Job { run() {} }
func count(q queue number) number { return q.length }
func runAll(q queue Job) {}
go count(queue<number>())
go runAll(queue<Job>())`),
    ).toEqual([
      '"runAll" runs in a worker, which gets a copy of argument 1, but a copy of Job would lose its class and methods',
    ]);
  });
});

describe('generated code', () => {
  it('makes a queue of the class of the module', () => {
    const code = js('const q = queue<number>([1, 2])\nlet empty queue string');

    expect(code).toContain('class $$Queue {');
    expect(code).toContain('const q = new $$Queue([1, 2]);');
    expect(code).toContain('let empty = new $$Queue();');
    expect(js('const n = 1')).not.toContain('$$Queue');
  });
});

describe('runtime', () => {
  it('takes values out at both ends and goes round its ring', async () => {
    expect(
      await run(`const q = queue<number>()
let taken []number
for let i = 0; i < 50; i++ {
    q.push(i, i + 100)
    taken.push(q.shift() ?? -1)
}
console.log(q.length, taken.slice(0, 4).join(" "), q.at(0), q.at(-1), q.at(50), q.at(-51))
q.unshift(-2, -1)
console.log(q.shift(), q.shift(), q.pop(), q.length)
let sum = 0
for v in q {
    sum += v
}
console.log(sum, [...q].length)
q.clear()
console.log(q.length, q.shift(), q.pop(), q.at(0))`),
    ).toEqual(['50 0 100 1 101 25 149 null null', '-2 -1 149 49', '4201 49', '0 null null null']);
  });

  it('keeps the order through growing and shrinking', async () => {
    expect(
      await run(`const q = queue<number>()
for let i = 0; i < 1000; i++ {
    if i % 2 == 0 {
        q.push(i)
    } else {
        q.unshift(i)
    }
}
let ok = q.length == 1000
for let i = 999; i >= 1; i -= 2 {
    ok = ok && q.shift() == i
}
for let i = 998; i >= 0; i -= 2 {
    ok = ok && q.pop() == i
}
console.log(ok, q.length)
const big = queue<number>()
for let i = 0; i < 100_000; i++ {
    big.push(i)
}
let total = 0
for big.length > 0 {
    total += big.shift() ?? 0
}
console.log(total)`),
    ).toEqual(['true 0', '4999950000']);
  });

  it('gives a zero value of its own to each variable and field', async () => {
    expect(
      await run(`class Box {
    items queue string
}
const a = new Box()
const b = new Box()
a.items.push("x")
let c queue string
console.log(a.items.length, b.items.length, c.length)`),
    ).toEqual(['1 0 0']);
  });
});

describe('markup', () => {
  it('follows the changes of a queue in state', () => {
    const { body } = mountWithDom(`comp Line() {
    state waiting = queue<string>(["a"])
    return <p>
        <button onClick={waiting.push("b")}>+</button>
        <button onClick={waiting.shift()}>-</button>
        {waiting.length}: {[...waiting].join(",")}
    </p>
}
document.body.append(<Line />)`);
    const [add, take] = body.findAll('button');
    const line = () => String(body.find('p')).replace(/<button>.<\/button>/g, '');

    add!.click();
    add!.click();
    expect(line()).toBe('<p>3: a,b,b</p>');
    take!.click();
    expect(line()).toBe('<p>2: b,b</p>');
  });
});

// Processes with workers take seconds while the other tests run too.
describe('threads', { timeout: 30_000 }, () => {
  it('goes to a worker and back, and through a channel', () => {
    const { stdout, stderr } = runBuilt(`func total(q queue number) queue number {
    let sum = 0
    for v in q {
        sum += v
    }
    q.shift()
    q.push(sum)
    return q
}

async func fill(out chan queue string) {
    const q = queue<string>(["a", "b"])
    q.unshift("z")
    out <- q
    close(out)
}

const q = queue<number>()
for let i = 1; i <= 20; i++ {
    q.push(i)
}
q.shift()
const back = await go total(q)
console.log(back.length, back.at(-1), back.at(0), q.length)
const ch = chan<queue string>()
go fill(ch)
const got = <-ch
console.log([...got].join(""), got.pop())
const closed = <-ch
closed.push("y")
console.log(closed.length, (<-ch).length)`);

    expect(stderr).toBe('');
    expect(stdout).toBe('19 209 3 19\nzab b\n1 0\n');
  });
});

describe('declaration files', () => {
  it('gives TypeScript the members of a queue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rook-queue-dts-'));

    writeFileSync(
      join(dir, 'jobs.rk'),
      'export func next(q queue ?string) ?string {\n    return q.shift()\n}\n',
    );

    const { outputs, errors: failures } = build([join(dir, 'jobs.rk')]);

    expect(failures).toEqual([]);
    expect(outputs[0]!.declarations!.code).toContain(
      'export declare function next(q: { readonly length: number; push(...items: (string | null)[]): number; unshift(...items: (string | null)[]): number; shift(): string | null; pop(): string | null; at(index: number): string | null; clear(): void; [Symbol.iterator](): Iterator<string | null> }): string | null;',
    );
    expect(readFileSync(join(dir, 'jobs.rk'), 'utf8')).toContain('queue ?string');
  });
});
