import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';

// Generated JS for declarations and statements; defer, expressions and running are in
// codegen-expressions.test.ts.

/** Generated code, without type checking: the snippets use names they do not declare. */
function js(source: string, options?: { rewriteImports?: boolean }): string {
  const { code, diagnostics } = compile(source, { ...options, typeCheck: false });

  expect(diagnostics).toEqual([]);

  return code.trimEnd();
}

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
