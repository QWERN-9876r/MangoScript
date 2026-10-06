import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';

/** Generated code, without type checking: the snippets use names they do not declare. */
function js(source: string, options?: { rewriteImports?: boolean }): string {
  const { code, diagnostics } = compile(source, { ...options, typeCheck: false });
  expect(diagnostics).toEqual([]);
  return code.trimEnd();
}

/** The JS for `x = <source>`, without the assignment around it. */
function jsExpression(source: string): string {
  return js(`x = ${source}`).replace(/^x = /, '').replace(/;$/, '');
}

/** Compiles and runs a program without imports or exports; returns what it printed. */
function run(source: string): string[] {
  const output: string[] = [];
  const fakeConsole = { log: (...args: unknown[]) => output.push(args.map(String).join(' ')) };
  const { code, diagnostics } = compile(source);
  expect(diagnostics).toEqual([]);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const program = new Function('console', `"use strict";\n${code}`) as (
    console: typeof fakeConsole,
  ) => void;
  program(fakeConsole);
  return output;
}

// ─── Generated code ──────────────────────────────────────────────────────────────────────────────

describe('declarations', () => {
  it('returns several results as an array', () => {
    expect(
      js(`func divide(a, b number) (number, error) {
    if b == 0 {
        return 0, error("division by zero")
    }
    return a / b, null
}

const q, err = divide(10, 2)`),
    ).toBe(`function divide(a, b) {
  if (b === 0) {
    return [0, new Error("division by zero")];
  }
  return [a / b, null];
}

const [q, err] = divide(10, 2);`);
  });

  it('initializes variables with zero values', () => {
    expect(
      js(`type ID string
let n number
let s string
let ok bool
let xs []number
let u ?User
let e error
let id ID
let a, b number
let p Point`),
    ).toBe(`let n = 0;
let s = "";
let ok = false;
let xs = [];
let u = null;
let e = null;
let id = "";
let a = 0, b = 0;
let p;`);
  });

  it('skips values assigned to _', () => {
    expect(js('const _, rest = f()')).toBe('const [, rest] = f();');
    expect(js('const first, _ = f()')).toBe('const [first] = f();');
    expect(js('const _ = f()')).toBe('f();');
    expect(js('let a, _ = 1, g()')).toBe('let [a] = [1, g()];');
    expect(js('a, b = b, a')).toBe('[a, b] = [b, a];');
    expect(js('_, err = f()')).toBe('[, err] = f();');
    expect(js('_ = f()')).toBe('f();');
  });

  it('compiles classes and erases visibility', () => {
    expect(
      js(`export class User extends Base {
    name string
    private age number
    static count = 0

    constructor(name string) {
        super()
        this.name = name
    }

    greet() string {
        return \`Hi, \${this.name}\`
    }
}`),
    ).toBe(`export class User extends Base {
  name = "";
  age = 0;
  static count = 0;

  constructor(name) {
    super();
    this.name = name;
  }

  greet() {
    return \`Hi, \${this.name}\`;
  }
}`);
  });

  it('erases interfaces and type aliases', () => {
    expect(js('interface I {\n  x number\n}\ntype T string\nexport interface J {}')).toBe('');
  });

  it('drops imports used only as types and rewrites .mango paths', () => {
    const source = `import { Point, dist } from "./geom.mango"
import * as path from "node:path"
import Types from "./types.mango"
import "./setup.mango"
const p Point = { x: 1, y: 2 }
console.log(dist(p), path.sep)
let t Types`;
    expect(js(source)).toBe(`import { dist } from "./geom.js";
import * as path from "node:path";
import "./setup.js";
const p = { x: 1, y: 2 };
console.log(dist(p), path.sep);
let t;`);
    expect(js(source, { rewriteImports: false })).toContain('import { dist } from "./geom.mango";');
  });

  it('keeps blank lines from the source', () => {
    expect(js('f()\n\n\ng()\nh()')).toBe('f();\n\ng();\nh();');
  });
});

describe('statements', () => {
  it('compiles all loop forms', () => {
    expect(
      js(`for {
    break
}
for running {
    tick()
}
for let i = 0; i < 3; i++ {
    f(i)
}
for x in xs {
    f(x)
}
for i, x in xs {
    f(i, x)
}`),
    ).toBe(`while (true) {
  break;
}
while (running) {
  tick();
}
for (let i = 0; i < 3; i++) {
  f(i);
}
for (const x of xs) {
  f(x);
}
for (const [i, x] of xs.entries()) {
  f(i, x);
}`);
  });

  it('adds break to switch cases and blocks to cases with declarations', () => {
    expect(
      js(`switch cmd {
case "start", "run":
    start()
case "stop":
    const reason = "user"
    stop(reason)
case "exit":
    throw error("exit")
default:
    help()
}`),
    ).toBe(`switch (cmd) {
  case "start":
  case "run":
    start();
    break;
  case "stop": {
    const reason = "user";
    stop(reason);
    break;
  }
  case "exit":
    throw new Error("exit");
  default:
    help();
}`);
  });

  it('compiles a switch without a discriminant to if/else', () => {
    expect(
      js(`switch {
case score >= 90:
    grade = "A"
case a, b:
    grade = "B"
default:
    grade = "C"
}`),
    ).toBe(`if (score >= 90) {
  grade = "A";
} else if (a || b) {
  grade = "B";
} else {
  grade = "C";
}`);
  });

  it('labels an if/else switch when a case breaks out of it', () => {
    expect(js('switch {\ncase done:\n    break\ndefault:\n    work()\n}')).toBe(
      `$$switch1: if (done) {
  break $$switch1;
} else {
  work();
}`,
    );
  });

  it('compiles try/catch/finally', () => {
    expect(js('try {\n    f()\n} catch e {\n    g(e)\n} finally {\n    h()\n}')).toBe(
      `try {
  f();
} catch (e) {
  g(e);
} finally {
  h();
}`,
    );
    expect(js('try {\n} catch {\n}')).toBe('try {} catch {}');
  });
});

describe('defer', () => {
  it('uses try/finally for defers at the top of a function', () => {
    expect(
      js(`func copy(path string) {
    const file = open(path)
    defer file.close()
    const backup = create(path + ".bak")
    defer backup.close()
    backup.write(file.read())
}`),
    ).toBe(`function copy(path) {
  const file = open(path);
  try {
    const backup = create(path + ".bak");
    try {
      backup.write(file.read());
    } finally {
      backup.close();
    }
  } finally {
    file.close();
  }
}`);
  });

  it('saves values that may change before the deferred call', () => {
    expect(
      js(`func f() {
    let x = 1
    defer log(x, items[0])
    x = 2
}`),
    ).toBe(`function f() {
  let x = 1;
  const $$0 = x;
  const $$1 = items[0];
  try {
    x = 2;
  } finally {
    log($$0, $$1);
  }
}`);
  });

  it('uses a stack of deferred calls when a defer is inside a loop', () => {
    expect(
      js(`func closeAll(files []File) {
    for file in files {
        defer file.close()
    }
}`),
    ).toBe(`function $$runDeferred(deferred) {
  let failure;
  for (let i = deferred.length - 1; i >= 0; i--) {
    try {
      deferred[i]();
    } catch (error) {
      failure = { error };
    }
  }
  if (failure) throw failure.error;
}

function closeAll(files) {
  const $$defer = [];
  try {
    for (const file of files) {
      $$defer.push(() => file.close());
    }
  } finally {
    $$runDeferred($$defer);
  }
}`);
  });
});

describe('expressions', () => {
  it.each([
    ['(a + b) * c', '(a + b) * c'],
    ['a - (b - c)', 'a - (b - c)'],
    ['a - b - c', 'a - b - c'],
    ['(a ** b) ** c', '(a ** b) ** c'],
    ['a ** b ** c', 'a ** b ** c'],
    ['(-a) ** b', '(-a) ** b'],
    ['-(a ** b)', '-(a ** b)'],
    ['(a ?? b) || c', '(a ?? b) || c'],
    ['a ?? (b || c)', 'a ?? (b || c)'],
    ['-(-a)', '- -a'],
    ['1.toFixed(2)', '(1).toFixed(2)'],
    ['new (getClass())()', 'new (getClass())()'],
    ['new User("Ann").greet()', 'new User("Ann").greet()'],
    ['(x => x)(1)', '((x) => x)(1)'],
    ['a ? b : (c ? d : e)', 'a ? b : c ? d : e'],
    ['(a ? b : c) ? d : e', '(a ? b : c) ? d : e'],
    ['typeof x == "string"', 'typeof x === "string"'],
    ['a != b', 'a !== b'],
    ['x == null', 'x == null'],
    ['null != x', 'null != x'],
    ['`a${b}c`', '`a${b}c`'],
    ['{ name, "k": 1, ...rest }', '{ name, "k": 1, ...rest }'],
    ['() => ({ a: 1 })', '() => ({ a: 1 })'],
    ['(a, b number) => a + b', '(a, b) => a + b'],
    ['xs?.[0]?.name', 'xs?.[0]?.name'],
    ['error("boom")', 'new Error("boom")'],
    ['error', 'Error'],
  ])('%s', (source, expected) => {
    expect(jsExpression(source)).toBe(expected);
  });

  it('compiles func literals to arrow functions', () => {
    expect(js('const double = func(x number) number {\n    return x * 2\n}')).toBe(
      'const double = (x) => {\n  return x * 2;\n};',
    );
  });

  it('wraps a statement that starts with an object literal', () => {
    expect(js('({ a: 1 }).f()')).toBe('({ a: 1 }.f());');
  });

  it('renames names that JS reserves', () => {
    expect(js('let delete = 1\nconsole.log({ delete }, delete)')).toBe(
      'let delete$ = 1;\nconsole.log({ delete: delete$ }, delete$);',
    );
  });

  it('treats error as the predeclared function only when it is not declared', () => {
    expect(
      js(`func a() {
    try {
    } catch error {
        log(error)
    }
}
func b() error {
    return error("x")
}
func c(error func(string) error) error {
    return error("y")
}`),
    ).toBe(`function a() {
  try {} catch (error) {
    log(error);
  }
}
function b() {
  return new Error("x");
}
function c(error) {
  return error("y");
}`);
  });
});

// ─── Behavior ────────────────────────────────────────────────────────────────────────────────────

describe('runtime behavior', () => {
  it('returns several values and swaps variables', () => {
    expect(
      run(`func divmod(a, b number) (number, number) {
    return Math.floor(a / b), a % b
}
let q, r = divmod(17, 5)
q, r = r, q
console.log(q, r)`),
    ).toEqual(['2 3']);
  });

  it('runs deferred calls in reverse order after the body', () => {
    expect(
      run(`func f() {
    defer console.log("first deferred")
    defer console.log("second deferred")
    console.log("body")
}
f()`),
    ).toEqual(['body', 'second deferred', 'first deferred']);
  });

  it('evaluates deferred arguments at the defer statement', () => {
    expect(
      run(`func f() {
    let x = 1
    defer console.log("deferred", x)
    x = 2
    console.log("body", x)
}
f()`),
    ).toEqual(['body 2', 'deferred 1']);
  });

  it('runs deferred calls when the function throws', () => {
    expect(
      run(`func f() {
    defer console.log("cleanup")
    throw error("boom")
}
try {
    f()
} catch e {
    console.log("caught", e.message)
}`),
    ).toEqual(['cleanup', 'caught boom']);
  });

  it('runs defers from a loop at function exit, last first', () => {
    expect(
      run(`func countdown() {
    for let i = 0; i < 3; i++ {
        defer console.log(i)
    }
    console.log("go")
}
countdown()`),
    ).toEqual(['go', '2', '1', '0']);
  });

  it('runs every deferred block even if one throws', () => {
    expect(
      run(`func f() {
    for x in [1, 2] {
        defer {
            console.log("deferred", x)
            if x == 2 { throw error("failed in defer") }
        }
    }
}
try {
    f()
} catch e {
    console.log(e.message)
}`),
    ).toEqual(['deferred 2', 'deferred 1', 'failed in defer']);
  });

  it('breaks out of an if/else switch, not the enclosing loop', () => {
    expect(
      run(`for x in [1, 2, 3] {
    switch {
    case x == 2:
        if true { break }
        console.log("not printed")
    default:
        console.log("x =", x)
    }
}`),
    ).toEqual(['x = 1', 'x = 3']);
  });

  it('gives each switch case its own scope', () => {
    expect(
      run(`func describe(n number) string {
    switch n {
    case 1, 2:
        const word = "small"
        return word
    case 3:
        const word = "three"
        return word
    default:
        return "big"
    }
}
console.log(describe(1), describe(3), describe(9))`),
    ).toEqual(['small three big']);
  });

  it('keeps this of the enclosing method inside func literals', () => {
    expect(
      run(`class Counter {
    count = 0

    incrementLater() func() {
        return func() { this.count++ }
    }
}
const counter = new Counter()
counter.incrementLater()()
console.log(counter.count)`),
    ).toEqual(['1']);
  });

  it('runs examples/hello.mango', () => {
    const source = readFileSync(new URL('../examples/hello.mango', import.meta.url), 'utf8');
    expect(run(source)).toEqual([
      '[divide]',
      '10 / 4 = 2.5',
      '10 / 0: division by zero',
      '[/divide]',
      '[stats]',
      'min = 1, max = 9, total = 31',
      '[/stats]',
      '[points]',
      'point 0: quadrant I',
      'point 1: quadrant II',
      'point 2: quadrant III',
      'first negative: (-1, -1)',
      '[/points]',
    ]);
  });
});
