import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';
import { errors as syntaxErrors, expr, first, sx } from './parser-helpers.ts';

// `async func` and `await`: an async function returns a Promise of its results, `await` gives
// them, and modules may await at the top level.

/** Errors of the compiler with TypeScript's lib files, as in Node. */
function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

/** Errors of the check without the lib files, as in the playground. */
function browserErrors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  expect(diagnostics).toEqual([]);

  return check(program).diagnostics.map((d) => d.message);
}

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
}

/** Runs a program that may await at the top level; returns what it printed. */
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('parsing', () => {
  it('reads async functions, methods, func literals and arrow functions', () => {
    expect(first('async func f() {}', 'FuncDeclaration').async).toBe(true);
    expect(first('func f() {}', 'FuncDeclaration').async).toBeUndefined();
    expect(first('export async func f() {}', 'FuncDeclaration').async).toBe(true);

    const [method] = first(
      'class A { private async load() number { return 1 } }',
      'ClassDeclaration',
    ).members;

    expect(method?.kind === 'MethodDeclaration' && method.async).toBe(true);
    expect(expr('async x => x')).toMatchObject({ kind: 'ArrowFunction', async: true });
    expect(expr('async (a, b number) => a + b')).toMatchObject({
      kind: 'ArrowFunction',
      async: true,
    });
    expect(expr('async func() {}')).toMatchObject({
      kind: 'FuncExpression',
      async: true,
      start: 4,
    });
  });

  it('reads await as a unary operator', () => {
    expect(sx(expr('await f() + 1'))).toBe('(+ (await (call f)) 1)');
    expect(sx(expr('await a.b().c'))).toBe(sx(expr('await (a.b().c)')));
  });

  it('allows await at the top level and as a statement', () => {
    expect(syntaxErrors('await f()\nconst x = await g()\nif ok { await h() }')).toEqual([]);
  });

  it.each([
    ['func f() { await g() }', '"await" is allowed only in async functions'],
    ['async func f() { const g = () => await h() }', '"await" is allowed only in async functions'],
    ['async func f() { defer { await g() } }', '"await" is not allowed inside "defer"'],
    ['async func f() { defer g(await h()) }', '"await" is not allowed inside "defer"'],
    ['comp A() { return <p>{await f()}</p> }', '"await" is allowed only in async functions'],
    ['document.body.append(<p>{await f()}</p>)', '"await" is allowed only in async functions'],
    ['class A { x = await f() }', '"await" is allowed only in async functions'],
    ['async comp A() { return <p /> }', 'a component cannot be async'],
    ['class A { async constructor() {} }', 'a constructor cannot be async'],
    ['class A { async x number }', 'only methods can be async'],
    ['x = async 1', 'expected a function after "async"'],
  ])('reports %j', (source, message) => {
    expect(syntaxErrors(source)).toEqual([expect.stringContaining(message)]);
  });
});

describe('types', () => {
  it('gives an async function the type of a Promise of its results', () => {
    const source = `async func load(id number) string { return "x" }
async func save() {}
async func pair() (number, error) { return 1, null }
`;

    expect(errors(`${source}const a number = load(1)`)).toEqual([
      'cannot use Promise[string] as number',
    ]);
    expect(errors(`${source}const a number = save()`)).toEqual([
      'cannot use Promise[void] as number',
    ]);
    expect(errors(`${source}const p Promise[string] = load(1)\nconst s string = await p`)).toEqual(
      [],
    );
    expect(
      errors(`${source}await save()\nconst n, err = await pair()\nconst m number = n`),
    ).toEqual([]);
    expect(errors(`${source}const s number = await load(1)`)).toEqual([
      'cannot use string as number',
    ]);
  });

  it('checks the returns of an async function against what its Promise gives', () => {
    expect(errors('async func f() number { return "x" }')).toEqual([
      'cannot use string as number in return',
    ]);
    expect(errors('async func f() number {}')).toEqual([
      'missing return at the end of the function',
    ]);
    expect(errors('async func f() (number, error) { return 1 }')).toEqual([
      'wrong number of return values: expected 2, got 1',
    ]);
    expect(errors('async func f() Promise[number] { return 1 }')).toEqual([
      'an async function declares what its Promise gives: write "number", not "Promise[number]"',
    ]);
  });

  it('types async methods, func literals and arrow functions', () => {
    expect(
      errors(`class Store {
    async get() number { return 1 }
}
const n number = await new Store().get()
const f = async (x number) => x * 2
const g = async func(x number) string { return "" }
const a number = await f(1)
const b string = await g(1)
const c string = await f(1)`),
    ).toEqual(['cannot use number as string']);
  });

  it('checks async arrow functions against the Promise their context expects', () => {
    expect(
      errors(`func run(f func() Promise[number]) {}
run(async () => 1)
run(async () => "x")
run(() => 1)`),
    ).toEqual([
      'cannot use string as number in return',
      'cannot use number as Promise[number] in return',
    ]);
  });

  it('takes async handlers of events', () => {
    expect(
      errors(`async func load() number { return 1 }
comp A() {
    state n = 0
    return <button onClick={async () => { n = await load() }}>{n}</button>
}`),
    ).toEqual([]);
  });

  it('infers the type of a new Promise from the expected type', () => {
    expect(
      errors(`async func sleep(ms number) {
    const done Promise[number] = new Promise(resolve => setTimeout(() => resolve(ms), ms))
    await done
}`),
    ).toEqual([]);
  });

  it('works without the lib files', () => {
    expect(
      browserErrors(`async func load() (string, error) { return "x", null }
const s, err = await load()
const n number = s
const p number = load()`),
    ).toEqual(['cannot use string as number', 'cannot use Promise[(string, error)] as number']);
  });
});

describe('code generation', () => {
  it('writes async functions and await', () => {
    expect(
      js(`export async func load(id number) (string, error) {
    const name = await fetchName(id)
    return name, null
}
func fetchName(id number) Promise[string] { return Promise.resolve("x") }
class A {
    static async make() A { return new A() }
}
const f = async (x number) => x
const g = async func(n number) number { return (await f(n)).toFixed().length }`),
    ).toBe(`export async function load(id) {
  const name = await fetchName(id);
  return [name, null];
}
function fetchName(id) {
  return Promise.resolve("x");
}
class A {
  static async make() {
    return new A();
  }
}
const f = async (x) => x;
const g = async (n) => {
  return (await f(n)).toFixed().length;
};
`);
  });

  it('declares an async function as one that returns a Promise', () => {
    const { declarations } = compile(
      'export async func load() (number, error) { return 1, null }',
      {
        declarations: true,
      },
    );

    expect(declarations).toContain(
      'export declare function load(): Promise<[number, Error | null]>;',
    );
  });
});

describe('runtime', () => {
  it('waits for async functions, also at the top level', async () => {
    expect(
      await run(`async func sleep(ms number) {
    const done Promise[number] = new Promise(resolve => setTimeout(() => resolve(ms), ms))
    await done
}
async func divide(a, b number) (number, error) {
    await sleep(1)
    if b == 0 {
        return 0, error("division by zero")
    }
    return a / b, null
}
const q, err = await divide(6, 3)
console.log(q, err)
const _, failed = await divide(1, 0)
console.log(failed?.message)`),
    ).toEqual(['2 null', 'division by zero']);
  });

  it('runs defer when an async function ends, after it has waited', async () => {
    expect(
      await run(`async func work() {
    defer console.log("done")
    await Promise.resolve(1)
    console.log("work")
}
await work()`),
    ).toEqual(['work', 'done']);
  });

  it('updates the markup after a change of state that comes after await', async () => {
    const { body } = mountWithDom(`async func load() number { return 42 }
comp A() {
    state n = 0
    return <button onClick={async () => { n = await load() }}>{n}</button>
}
document.body.append(<A />)`);

    body.find('button').click();
    expect(String(body)).toContain('<button>0</button>');
    await tick();
    expect(String(body)).toContain('<button>42</button>');
  });
});
