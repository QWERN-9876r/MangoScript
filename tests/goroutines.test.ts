import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';
import { errors as syntaxErrors, expr, sx } from './parser-helpers.ts';

// `go work(x)`: the call of a function in a worker of the module's pool, with copies of the
// arguments; a Promise of what the function returns.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

function compiled(source: string): { code: string; worker: string | undefined } {
  const { code, worker, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return { code, worker };
}

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

/** Runs a program with `mango run`, or builds it and runs the `.js`; returns its output. */
function run(source: string, how: 'run' | 'build'): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mango-go-'));

  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(dir, 'main.mango'), source);

  const options = { cwd: dir, encoding: 'utf8' as const, timeout: 20_000 };

  if (how === 'build') {
    const built = spawnSync(process.execPath, [cli, 'build', 'main.mango'], options);

    expect(built.stderr).toBe('');
    expect(readFileSync(join(dir, 'main.worker.js'), 'utf8')).toContain('$$serve($$goroutines);');

    return spawnSync(process.execPath, ['main.js'], options);
  }

  return spawnSync(process.execPath, [cli, 'run', 'main.mango'], options);
}

const work = `func square(n number) number {
    return n * n
}
`;

describe('parsing', () => {
  it('reads go before a call, as an expression and as a statement', () => {
    expect(sx(expr('go f(1, x)'))).toBe('(go (call f 1 x))');
    expect(sx(expr('await go f()'))).toBe('(await (go (call f)))');
    expect(syntaxErrors('go f()\nconst a, b = await go g()')).toEqual([]);
  });

  it.each([
    ['go f', '"go" needs a call of a function, e.g. "go work(x)"'],
    ['go f?.()', '"go" needs a call of a function'],
    ['go 1 + 2', '"go" needs a call of a function'],
  ])('reports %j', (source, message) => {
    expect(syntaxErrors(`x = ${source}`)).toEqual([expect.stringContaining(message)]);
  });
});

describe('types', () => {
  it('gives a Promise of what the function returns, also of an async one', () => {
    expect(
      errors(`${work}async func load(id number) (string, error) { return "x", null }
func nothing() {}
const n number = await go square(2)
const s, err = await go load(1)
const t string = s
await go nothing()
go square(3)
const p number = go square(2)`),
    ).toEqual(['cannot use Promise<number> as number']);
  });

  it('calls only functions of the top level of the module and imports', () => {
    const message =
      '"go" calls a function declared at the top level of a module or imported: a worker has only those, e.g. "go work(x)"';

    expect(
      errors(`${work}const f = (n number) => n
class A { m() {} }
func outer() {
    func inner() {}
    go inner()
}
go f(1)
go new A().m()
go Math.max(1, 2)`),
    ).toEqual([message, message, message, message]);
  });

  it('checks that the arguments and the result can be copied', () => {
    expect(
      errors(`interface Point { x, y number }
interface Shape { area() number }
class Box { size number }
func take(a any) {}
func points(ps []Point, m Map<string, Date>, b ?Uint8Array, e error) []Point { return ps }
func callback(f func()) {}
func shape(s Shape) {}
func box(b Box) {}
func makeBox() Box { return new Box() }
await go points([{ x: 1, y: 2 }], new Map(), null, null)
go callback(() => {})
go shape({ area: () => 1 })
go box(new Box())
await go makeBox()
go take(document.body)`),
    ).toEqual([
      '"callback" runs in a worker, which gets a copy of argument 1, but a function cannot be copied',
      '"shape" runs in a worker, which gets a copy of argument 1, but a function cannot be copied',
      '"box" runs in a worker, which gets a copy of argument 1, but a copy of Box would lose its class and methods',
      '"makeBox" runs in a worker, which sends back a copy of its result, but a copy of Box would lose its class and methods',
      '"take" runs in a worker, which gets a copy of argument 1, but a copy of HTMLElement would lose its methods',
    ]);
  });

  it('reports the variables and the markup of the module that the code reaches', () => {
    expect(
      errors(`let total = 0
const STEP = 2
func add(n number) {
    total += n * STEP
}
comp Card() { return <p /> }
func render() {
    document.body.append(<Card />)
}
go add(1)
go add(2)
go render()`),
    ).toEqual([
      '"add" runs in a worker, which does not share the variables of the module, but its code uses "total"; pass the value as an argument, or make it a const',
      '"render" runs in a worker, which has no document, but its code uses the markup in "render"',
    ]);
  });
});

describe('code generation', () => {
  it('calls the function in the pool of the module, which starts its worker module', () => {
    const { code } = compiled(`${work}const n = await go square(2)`);

    expect(code).toContain('const n = await $$go("square", [2]);');
    expect(code).toContain(
      'return new Worker(new URL("./main.worker.js", import.meta.url), { type: "module" });',
    );
    expect(code).toContain('function $$pool(start) {');
  });

  it('puts into the worker module what the functions reach, and not the rest of the module', () => {
    const { worker } = compiled(`import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
const LIMIT = 10
const UNUSED = 1
class Counter {
    count = 0
    add() { this.count += LIMIT }
}
export func work(path string) number {
    const counter = new Counter()
    counter.add()
    go helper(path)
    return readFileSync(join(path, "x"), "utf8").length + counter.count
}
func helper(path string) {}
console.log("main")
go work(".")`);

    expect(worker).toContain('import { readFileSync } from "node:fs";');
    expect(worker).toContain('import { join } from "node:path";');
    expect(worker).toContain('const LIMIT = 10;');
    expect(worker).toContain('class Counter {');
    expect(worker).toContain('function work(path) {');
    expect(worker).not.toContain('export');
    expect(worker).not.toContain('UNUSED');
    expect(worker).not.toContain('console.log("main")');
    expect(worker).toContain('const copies = structuredClone(args);');
    expect(worker).toContain('const $$goroutines = { helper, work };');
  });

  it('writes no worker module without go', () => {
    expect(compiled(work).worker).toBeUndefined();
  });
});

// Processes with workers take seconds while the other tests run too.
describe('runtime', { timeout: 30_000 }, () => {
  const program = `${work}
async func divide(a, b number) (number, error) {
    if b == 0 {
        return 0, error("division by zero")
    }
    return a / b, null
}

func fail() number {
    throw new Error("boom")
}

func sumOfSquares(n number) number {
    return n * n
}

async func nested(n number) number {
    return await go sumOfSquares(n) + 1
}

console.log("main")
const squares = await Promise.all([1, 2, 3, 4, 5].map(n => go square(n)))
console.log(squares.join(" "))
const q, err = await go divide(1, 0)
console.log(q, err?.message)
console.log(await go nested(3))
try {
    await go fail()
} catch e {
    console.log("caught:", e.message)
}
go square(1)
`;
  const output = 'main\n1 4 9 16 25\n0 division by zero\n10\ncaught: boom\n';

  it.each(['build', 'run'] as const)(
    'runs the functions in workers and gives back results and errors (%s)',
    (how) => {
      const { stdout, stderr } = run(program, how);

      expect(stderr).toBe('');
      expect(stdout).toBe(output);
    },
  );

  it('fails the program when a goroutine that nothing waits for throws', () => {
    const { stdout, stderr } = run(`func fail() { throw new Error("boom") }\ngo fail()`, 'build');

    expect(stdout).toBe('');
    expect(stderr).toContain('boom');
  });
});
