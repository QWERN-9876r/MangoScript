import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);
  expect(diagnostics).toEqual([]);
  return check(program).diagnostics.map((d) => d.message);
}

/** Valid programs: [description, source]. */
type Valid = [string, string];
/** Programs with one error: [source, message]. */
type Invalid = [string, string];

function valid(cases: Valid[]) {
  it.each(cases)('accepts %s', (_, source) => {
    expect(errors(source)).toEqual([]);
  });
}

function invalid(cases: Invalid[]) {
  it.each(cases)('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
}

describe('basic types', () => {
  valid([
    ['inferred variables', 'let n = 1\nconst s = "a"\nlet ok = true\nn = n + 1'],
    ['zero values', 'let n number\nlet s string\nlet xs []number\nlet u ?string\nlet e error'],
    ['type aliases', 'type ID string\nlet id ID\nconst s string = id'],
    [
      'recursive types',
      'type Node { value number; next ?Node }\nconst n Node = { value: 1, next: { value: 2, next: null } }',
    ],
    ['template strings with any values', 'const n = 1\nconst s = `n = ${n}, ok = ${true}`'],
    ['string concatenation', 'const s = "a" + "b"'],
    ['comparisons', 'const a = 1 < 2\nconst b = "a" < "b"\nconst c = 1 == 2'],
  ]);

  invalid([
    ['let x number = "a"', 'cannot use string as number'],
    ['const s = "a" + 1', 'cannot add string and number: use a template string, e.g. `${a}${b}`'],
    ['const n = "a" * 2', '"*" needs numbers, not string and number'],
    ['const b = 1 == "1"', 'cannot compare number and string'],
    ['const PI = 3.14\nPI = 3', 'cannot assign to "PI": it is a constant'],
    ['let x = null', 'cannot infer a type from null: declare it, e.g. "let x ?User = null"'],
    ['let xs = []', 'cannot infer the type of an empty array: declare it, e.g. "let xs []number"'],
    ['const xs = [1, "a"]', 'array elements have different types: number and string'],
    ['undefinedThing()', '"undefinedThing" is not defined'],
    ['let x Missing', 'unknown type "Missing"'],
    ['type A A', 'type "A" refers to itself'],
    [
      'class User {}\nlet u User',
      'User has no zero value: give "u" a value or make it nullable with ?User',
    ],
    ['let n = 1\nn = "a"', 'cannot use string as number'],
    ['let s = "abc"\ns[0] = "x"', 'cannot assign to a character: strings cannot be changed'],
    ['for x in [1] {\n  x = 2\n}', 'cannot assign to loop variable "x"'],
    ['let n = 1\nn++\nlet s = "a"\ns++', '"++" needs a number, not string'],
    ['console.log(_)', '"_" cannot be used as a value'],
  ]);
});

describe('conditions', () => {
  invalid([
    ['let n = 1\nif n {\n}', 'condition must be bool, not number: compare it, e.g. "n != 0"'],
    [
      'let s ?string = null\nif s {\n}',
      'condition must be bool, not ?string: compare it with null, e.g. "x != null"',
    ],
    ['const a = 1\nconst b = a && true', '"&&" needs bool, not number'],
    ['const b = !"yes"', '"!" needs bool, not string'],
    ['for 1 {\n}', 'condition must be bool, not number: compare it, e.g. "n != 0"'],
  ]);
});

describe('null safety', () => {
  const user = 'class User {\n  name string\n  constructor(name string) { this.name = name }\n}\n';
  const find = `${user}func find() ?User { return null }\n`;

  valid([
    ['checks with if', `${find}const u = find()\nif u != null {\n  console.log(u.name)\n}`],
    [
      'early return',
      `${find}func f() {\n  const u = find()\n  if u == null { return }\n  console.log(u.name)\n}`,
    ],
    [
      'early continue',
      `${find}for x in [1] {\n  const u = find()\n  if u == null { continue }\n  console.log(u.name)\n}`,
    ],
    ['&&', `${user}func f(u ?User) bool { return u != null && u.name == "a" }`],
    [
      '|| with early return',
      `${user}func f(a, b ?User) string {\n  if a == null || b == null { return "" }\n  return a.name + b.name\n}`,
    ],
    ['?: branches', `${user}func f(u ?User) string { return u != null ? u.name : "" }`],
    ['optional chaining with ??', `${user}func f(u ?User) string { return u?.name ?? "anon" }`],
    ['optional calls', 'func f(cb ?func()) { cb?.() }'],
    ['a non-null initial value', `${user}let u ?User = new User("Ann")\nconsole.log(u.name)`],
    [
      'loop conditions',
      'class N {\n  value number\n  next ?N\n}\nfunc sum(head ?N) number {\n  let total number\n  let node = head\n  for node != null {\n    total += node.value\n    node = node.next\n  }\n  return total\n}',
    ],
    [
      'constants in closures',
      `${user}func f(x ?User) {\n  const u = x\n  if u == null { return }\n  const g = () => u.name\n}`,
    ],
    [
      'the error type',
      'func f() error { return null }\nconst err = f()\nif err != null {\n  console.log(err.message)\n}',
    ],
  ]);

  invalid([
    [
      `${find}const u = find()\nconsole.log(u.name)`,
      '"u" may be null: check it with "if u != null" or use "?."',
    ],
    [`${user}let u User = null`, 'cannot use null as User'],
    [`${find}const u User = find()`, 'cannot use ?User as User: it may be null, check it first'],
    [
      `${user}func f(u ?User) string { return u?.name }`,
      'cannot use ?string as string in return: it may be null, check it first',
    ],
    [
      'func f() error { return null }\nconst err = f()\nconsole.log(err.message)',
      '"err" may be null: check it with "if err != null" or use "?."',
    ],
    [
      `${user}func f(u ?User) {\n  if u == null { return }\n  const g = () => u.name\n  u = null\n}`,
      '"u" may be null: check it with "if u != null" or use "?."',
    ],
    [
      'const x = [1, 2].find(v => v > 1)\nconsole.log(x + 1)',
      'cannot add ?number and number: a value may be null, check it first',
    ],
    ['func f(cb ?func()) { cb() }', '"cb" may be null: check it with "if cb != null" or use "?."'],
  ]);
});

describe('functions', () => {
  valid([
    ['several results', 'func f() (number, error) { return 1, null }\nconst n, err = f()'],
    ['skipped results', 'func f() (number, error) { return 1, null }\nconst _, err = f()'],
    [
      'passing results on',
      'func a() (number, error) { return 1, null }\nfunc b() (number, error) { return a() }',
    ],
    ['swaps', 'let a, b = 1, 2\na, b = b, a'],
    ['hoisting', 'f()\nfunc f() {}'],
    ['infinite loops end a function', 'func f() number {\n  for {\n    return 1\n  }\n}'],
    [
      'switch with default ends a function',
      'func f(n number) string {\n  switch n {\n  case 1:\n    return "one"\n  default:\n    return "many"\n  }\n}',
    ],
    [
      'callbacks typed from the context',
      'func apply(f func(number) bool) bool { return f(1) }\napply(n => n > 0)',
    ],
    [
      'func literals',
      'const square = func(x number) number { return x * x }\nconst n number = square(2)',
    ],
    ['arrow results inferred', 'const double = (x number) => x * 2\nconst n number = double(2)'],
    [
      'callbacks that return values where none are expected',
      'func run(f func()) { f() }\nrun(() => 1)',
    ],
  ]);

  invalid([
    [
      'func f(a number) number {\n  if a > 0 { return 1 }\n}',
      'missing return at the end of the function',
    ],
    ['func f() { return 1 }', 'too many return values: this function returns nothing'],
    ['func f() (number, error) { return 1 }', 'wrong number of return values: expected 2, got 1'],
    ['func f() number { return }', 'missing return values: expected 1 value'],
    ['func f() number { return "a" }', 'cannot use string as number in return'],
    [
      'func f() (number, error) { return 1, null }\nconst x = f()',
      'f() returns 2 values: unpack them, e.g. "const a, b = ..."',
    ],
    [
      'func f() (number, error) { return 1, null }\nconst a, b, c = f()',
      'assignment mismatch: 3 variables but f() returns 2 values',
    ],
    ['func f() {}\nconst x = f()', 'f() does not return a value'],
    ['func f(a, b number) {}\nf(1)', 'not enough arguments: expected 2, got 1'],
    ['func f(a number) {}\nf(1, 2)', 'too many arguments: expected 1, got 2'],
    ['func f(a, b number) {}\nf(1, "x")', 'cannot use string as number in argument 2'],
    [
      'func apply(f func(number) bool) {}\napply((n number) => n * 2)',
      'cannot use number as bool in return',
    ],
    ['const f = (x) => x', 'cannot infer the type of parameter "x": add a type'],
    ['const n = 1\nn()', 'number cannot be called'],
  ]);
});

describe('classes', () => {
  valid([
    [
      'constructors, fields and methods',
      'class Counter {\n  count number\n  step = 1\n  constructor(step number) { this.step = step }\n  next() number {\n    this.count += this.step\n    return this.count\n  }\n}\nconst n number = new Counter(2).next()',
    ],
    [
      'static members',
      'class C {\n  static count = 0\n  static inc() { C.count++ }\n}\nC.inc()\nconst n number = C.count',
    ],
    [
      'inheritance and super',
      'class A {\n  greet() string { return "a" }\n}\nclass B extends A {\n  greet() string { return super.greet() + "b" }\n}\nconst a A = new B()',
    ],
    [
      'private members inside the class',
      'class A {\n  private secret = 1\n  reveal() number { return this.secret }\n}',
    ],
    [
      'protected members in subclasses',
      'class A {\n  protected base = 1\n}\nclass B extends A {\n  value() number { return this.base }\n}',
    ],
    [
      'fields assigned in the constructor',
      'class U {}\nclass Box {\n  user U\n  constructor(u U) { this.user = u }\n}',
    ],
    [
      'this in func literals',
      'class C {\n  count = 0\n  later() func() {\n    return func() { this.count++ }\n  }\n}',
    ],
    [
      'extending JS classes',
      'import { EventEmitter } from "node:events"\nclass Bus extends EventEmitter {\n  constructor() { super() }\n  fire() { this.emit("x") }\n}',
    ],
  ]);

  invalid([
    ['class A {\n  private secret = 1\n}\nconsole.log(new A().secret)', '"secret" is private in A'],
    ['class A {\n  protected x = 1\n}\nconsole.log(new A().x)', '"x" is protected in A'],
    ['class A {}\nconsole.log(new A().missing)', 'A has no member "missing"'],
    [
      'class P {\n  constructor(x, y number) {}\n}\nconst p = new P(1)',
      'not enough arguments: expected 2, got 1',
    ],
    ['class P {}\nconst p = P()', 'use "new P(...)" to create a P'],
    [
      'class A {}\nclass B extends A {\n  constructor() {}\n}',
      'the constructor of a derived class must call super(...)',
    ],
    [
      'class U {}\nclass Box {\n  user U\n}',
      'field "user" needs a value: U has no zero value, so initialize it here or assign it in the constructor',
    ],
    [
      'class A {\n  greet() string { return "a" }\n}\nclass B extends A {\n  greet() number { return 1 }\n}',
      '"greet" overrides A.greet with an incompatible type: func() number instead of func() string',
    ],
    [
      'interface Shape {\n  area() number\n}\nclass C implements Shape {}',
      'class "C" does not implement Shape: missing "area"',
    ],
    ['class A {\n  m() {}\n}\nconst a = new A()\na.m = 1', 'cannot assign to method "m"'],
    ['func f() { console.log(this) }', '"this" can only be used inside a class'],
    ['class A extends A {}', 'class "A" cannot extend itself'],
  ]);
});

describe('interfaces and objects', () => {
  const point = 'interface Point {\n  x, y number\n  label ?string\n}\n';
  valid([
    ['object literals', `${point}const p Point = { x: 1, y: 2 }`],
    ['optional fields', `${point}const p Point = { x: 1, y: 2, label: "a" }`],
    ['classes as interfaces', `${point}class P {\n  x = 1\n  y = 2\n}\nconst p Point = new P()`],
    ['spread', `${point}const p Point = { x: 1, y: 2 }\nconst q Point = { ...p, x: 3 }`],
    ['anonymous object types', 'func f(opts { verbose bool }) {}\nf({ verbose: true })'],
  ]);

  invalid([
    [`${point}const p Point = { x: 1 }`, 'cannot use { x number } as Point: missing "y"'],
    [`${point}const p Point = { x: 1, y: "2" }`, 'cannot use string as number for field "y"'],
    [`${point}const p Point = { x: 1, y: 2, z: 3 }`, 'Point has no field "z"'],
    ['const o = { a: 1, a: 2 }', 'duplicate field "a"'],
  ]);
});

describe('builtins', () => {
  valid([
    [
      'array methods',
      'const xs = [1, 2, 3]\nconst doubled []number = xs.map(x => x * 2)\nconst evens []number = xs.filter(x => x % 2 == 0)\nconst total number = xs.reduce((sum, x) => sum + x, 0)\nxs.push(4)',
    ],
    ['map to another type', 'const names []string = [1, 2].map(n => `#${n}`)'],
    ['string methods', 'const parts []string = "a, b".split(",").map(p => p.trim().toUpperCase())'],
    [
      'console, Math, JSON',
      'console.log(Math.max(1, 2), Math.floor(2.5), JSON.stringify({ a: 1 }))',
    ],
    [
      'callable builtins',
      'const n number = Number("1")\nconst s string = String(1)\nconst nan bool = Number.isNaN(n)',
    ],
    [
      'errors',
      'const e = error("boom")\nconst msg string = e.message\nconst err error = new Error("x")',
    ],
    ['catch', 'try {\n  JSON.parse("x")\n} catch e {\n  console.log(e.message)\n}'],
    ['untyped JS globals', 'const now = Date.now()\nconst m = new Map()'],
  ]);

  invalid([
    ['const s = "abc"\nconsole.log(s.lenght)', 'string has no member "lenght"'],
    ['const ys = [1].filter(v => v * 2)', 'cannot use number as bool in return'],
    ['const m = Math.max(1, "2")', 'cannot use string as number in argument 2'],
    ['for x in 5 {\n}', 'cannot iterate over number'],
    ['const s string = [1].map(x => x * 2)', 'cannot use []number as string'],
  ]);
});

describe('JS interop', () => {
  valid([
    [
      'untyped imports',
      'import express from "express"\nconst app = express()\napp.get("/", (req, res) => { res.send("hi") })',
    ],
    [
      'untyped callback parameters',
      'import { readFile } from "node:fs"\nreadFile("x", (err, data) => { console.log(data) })',
    ],
    ['untyped types', 'import { Request } from "express"\nfunc handle(req Request) {}'],
  ]);
});

describe('modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mango-check-'));
  writeFileSync(
    join(dir, 'geom.mango'),
    'export interface Point {\n    x, y number\n}\n\nexport func dist(p Point) number {\n    return Math.sqrt(p.x ** 2 + p.y ** 2)\n}\n\nfunc hidden() {}\n',
  );
  const compileIn = (source: string) =>
    compile(source, { filename: join(dir, 'main.mango') }).diagnostics.map((d) => d.message);

  it('uses the types exported by imported modules', () => {
    expect(
      compileIn(
        'import { Point, dist } from "./geom.mango"\nconst n number = dist({ x: 3, y: 4 })',
      ),
    ).toEqual([]);
    expect(
      compileIn('import { dist } from "./geom.mango"\nconst s string = dist({ x: 3, y: 4 })'),
    ).toEqual(['cannot use number as string']);
  });

  it('reports names that are not exported and missing modules', () => {
    expect(compileIn('import { hidden } from "./geom.mango"')).toEqual([
      '"hidden" is not exported by "./geom.mango"',
    ]);
    expect(compileIn('import { x } from "./missing.mango"')).toEqual([
      'cannot find module "./missing.mango"',
    ]);
  });
});

it('accepts examples/hello.mango', () => {
  const source = readFileSync(new URL('../examples/hello.mango', import.meta.url), 'utf8');
  expect(errors(source)).toEqual([]);
});
