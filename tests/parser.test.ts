import { describe, expect, it } from 'vitest';
import type * as ast from '../src/ast.ts';
import { parse } from '../src/parser/parser.ts';
import {
  errors,
  expr,
  first,
  member,
  param,
  results,
  statements,
  sx,
  ty,
} from './parser-helpers.ts';

// The parser: expressions, functions, variables, types, interfaces and classes. Statements and
// error recovery are in parser-statements.test.ts.

describe('expressions', () => {
  it.each([
    ['a + b * c', '(+ a (* b c))'],
    ['a * b + c', '(+ (* a b) c)'],
    ['a - b - c', '(- (- a b) c)'],
    ['a ** b ** c', '(** a (** b c))'],
    ['a || b && c', '(|| a (&& b c))'],
    ['a == b < c', '(== a (< b c))'],
    ['a & b | c ^ d', '(| (& a b) (^ c d))'],
    ['a << 1 + 2', '(<< a (+ 1 2))'],
    ['a ?? b ?? c', '(?? (?? a b) c)'],
    ['(a + b) * c', '(* (+ a b) c)'],
    ['-a.b()', '(- (call (. a b)))'],
    ['!a && b', '(&& (! a) b)'],
    ['typeof x == "number"', '(== (typeof x) "number")'],
    ['e instanceof Error', '(instanceof e Error)'],
    ['a ? b : c ? d : e', '(? a b (? c d e))'],
    ['a ** -b', '(** a (- b))'],
    ['(-a) ** b', '(** (- a) b)'],
    ['(a || b) ?? c', '(?? (|| a b) c)'],
  ])('%s', (source, expected) => {
    expect(sx(expr(source))).toBe(expected);
  });

  it.each([
    ['a.b?.c[0]?.[1](x)?.(y)', '(?call (call (?[] ([] (?. (. a b) c) 0) 1) x) y)'],
    ['xs.map(f).default', '(. (call (. xs map) f) default)'],
    ['f(a, ...rest,)', '(call f a (... rest))'],
    ['new User("Ann", 30).greet()', '(call (. (new User "Ann" 30) greet))'],
    ['new a.b.C', '(new (. (. a b) C))'],
    ['super.greet()', '(call (. super greet))'],
  ])('%s', (source, expected) => {
    expect(sx(expr(source))).toBe(expected);
  });

  it.each([
    ['[1, 2, ...rest,]', '[1 2 (... rest)]'],
    [
      '{ name: "Ann", age, "content-type": t, default: 1, ...defaults }',
      '{name: "Ann" age "content-type": t default: 1 (... defaults)}',
    ],
    ['{\n  x: 1,\n  y: 2\n}', '{x: 1 y: 2}'],
    ['`a${x}b${y + 1}c`', '(` "a" x "b" (+ y 1) "c")'],
    ['`plain`', '(` "plain")'],
    ['0xff', '0xff'],
    ['true', 'true'],
    ['null', 'null'],
  ])('%s', (source, expected) => {
    expect(sx(expr(source))).toBe(expected);
  });

  it.each([
    ['a ?? b || c', '"??" cannot be mixed with "||" or "&&" without parentheses'],
    ['a || b ?? c', '"??" cannot be mixed with "||" or "&&" without parentheses'],
    ['-a ** b', 'wrap the unary expression in parentheses'],
    ['{ "key" }', 'expected ":" after property name'],
    ['super', '"super" must be followed by "(" or "."'],
    ['await f()', '"await" is reserved for future use'],
    ['(', 'expected expression, found end of file'],
  ])('reports %j', (source, message) => {
    expect(errors(`x = ${source}`)).toEqual([expect.stringContaining(message)]);
  });

  it('records spans', () => {
    expect(expr('a + b * c')).toMatchObject({ start: 4, end: 13, right: { start: 8, end: 13 } });
  });
});

// ─── Functions ───────────────────────────────────────────────────────────────────────────────────

describe('functions', () => {
  it('parses declarations with grouped parameters and several results', () => {
    const node = first(
      'func divide(a, b number) (number, error) {\n  return a / b, null\n}',
      'FuncDeclaration',
    );
    expect(node.name.name).toBe('divide');
    expect(node.params.map(param)).toEqual(['a number', 'b number']);
    expect(node.params[0]!.type).toBe(node.params[1]!.type);
    expect(results(node.results)).toBe(' (number, error)');
    expect(node.body.body).toMatchObject([{ kind: 'ReturnStatement', values: [{}, {}] }]);
  });

  it.each([
    ['func f() {}', ''],
    ['func f() ?User {}', ' ?User'],
    ['func f() []string {}', ' []string'],
    ['func f() ({ x number }) {}', ' { x number }'],
    ['func f(cb func(number) bool) {}', ''],
  ])('parses results of %j', (source, expected) => {
    expect(results(first(source, 'FuncDeclaration').results)).toBe(expected);
  });

  it('parses arrow functions', () => {
    expect(sx(expr('x => x * 2'))).toBe('(=> (x) (* x 2))');
    expect(sx(expr('() => { return 1 }'))).toBe('(=> () {...})');
    expect(sx(expr('(a, b number, c) => a + b'))).toBe('(=> (a number b number c) (+ a b))');
  });

  it('tells parenthesized expressions from arrow parameters', () => {
    expect(sx(expr('(a)'))).toBe('a');
    expect(sx(expr('(a, b) => (a)'))).toBe('(=> (a b) a)');
    expect(sx(expr('f((a), (b) => b)'))).toBe('(call f a (=> (b) b))');
  });

  it('parses function literals', () => {
    expect(sx(expr('func(x number) number { return x * x }'))).toBe(
      '(func (x number) number {...})',
    );
    expect(statements('func() {\n  init()\n}()')).toMatchObject([
      { kind: 'ExpressionStatement', expression: { kind: 'CallExpression' } },
    ]);
  });

  it('reports a missing parameter type', () => {
    expect(errors('func f(a, b) {}')).toEqual(['missing type for parameter "a"']);
  });
});

// ─── Declarations ────────────────────────────────────────────────────────────────────────────────

describe('variables', () => {
  const summary = (node: ast.VariableDeclaration) =>
    [
      node.keyword,
      node.names.map((n) => n.name).join(', '),
      node.type ? ty(node.type) : '-',
      node.values.map(sx).join(', ') || '-',
    ].join(' | ');

  it.each([
    ['let x number', 'let | x | number | -'],
    ['const PI = 3.14', 'const | PI | - | 3.14'],
    ['let a, b = 1, 2', 'let | a, b | - | 1, 2'],
    ['const q, err = divide(10, 2)', 'const | q, err | - | (call divide 10 2)'],
    ['const _, rest = f()', 'const | _, rest | - | (call f)'],
    ['const p Point = { x: 1 }', 'const | p | Point | {x: 1}'],
    ['let xs []?number', 'let | xs | []?number | -'],
  ])('%s', (source, expected) => {
    expect(summary(first(source, 'VariableDeclaration'))).toBe(expected);
  });

  it.each([
    ['let x', '"x" needs a type or a value'],
    ['const x number', 'constants need a value'],
    ['let a, b = 1, 2, 3', 'assignment mismatch: 2 variables but 3 values'],
    ['let a = 1, 2', 'assignment mismatch: 1 variable but 2 values'],
    ['var x = 1', '"var" is not a MangoScript keyword: declare variables with "let" or "const"'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('types', () => {
  it.each([
    ['type ID string', 'string'],
    ['type Handler func(string, number) (bool, error)', 'func(string, number) (bool, error)'],
    ['type Pair { a, b number; label ?string }', '{ a number; b number; label ?string }'],
    ['type Point { x number, y number }', '{ x number; y number }'],
    ['type Matrix [][]number', '[][]number'],
    ['type Callback ?func()', '?func()'],
  ])('%s', (source, expected) => {
    expect(ty(first(source, 'TypeAliasDeclaration').type)).toBe(expected);
  });
});

describe('interfaces', () => {
  it('parses properties and methods', () => {
    const node = first(
      'interface Shape {\n  name string\n  x, y number\n  label ?string\n  area() number\n  move(dx, dy number)\n}',
      'InterfaceDeclaration',
    );
    expect(node.members.map(member)).toEqual([
      'name string',
      'x number',
      'y number',
      'label ?string',
      'area() number',
      'move(dx number, dy number)',
    ]);
  });
});

describe('classes', () => {
  const describeMember = (node: ast.ClassMember): string => {
    const words: (string | false)[] = [node.kind, node.visibility];
    switch (node.kind) {
      case 'FieldDeclaration':
        words.push(node.isStatic && 'static', node.name.name);
        if (node.type) words.push(ty(node.type));
        if (node.value) words.push(`= ${sx(node.value)}`);
        break;
      case 'ConstructorDeclaration':
        words.push(`(${node.params.map(param).join(', ')})`);
        break;
      case 'MethodDeclaration':
        words.push(
          node.isStatic && 'static',
          `${node.name.name}(${node.params.map(param).join(', ')})${results(node.results)}`,
        );
        break;
    }
    return words.filter(Boolean).join(' ');
  };

  it('parses fields, constructors and methods', () => {
    const node = first(
      `class Admin extends User implements Shape, Named {
  name string
  private age, level number
  static count = 0
  protected constructor(name string) {
    super(name)
  }
  greet() string {
    return \`Hi, \${this.name}\`
  }
  static create() Admin {
    return new Admin("root")
  }
  default() {}
}`,
      'ClassDeclaration',
    );
    expect(sx(node.superClass!)).toBe('User');
    expect(node.implements.map((type) => type.name.name)).toEqual(['Shape', 'Named']);
    expect(node.members.map(describeMember)).toEqual([
      'FieldDeclaration public name string',
      'FieldDeclaration private age number',
      'FieldDeclaration private level number',
      'FieldDeclaration public static count = 0',
      'ConstructorDeclaration protected (name string)',
      'MethodDeclaration public greet() string',
      'MethodDeclaration public static create() Admin',
      'MethodDeclaration public default()',
    ]);
  });

  it.each([
    ['class A {\n  x\n}', 'field "x" needs a type or a value'],
    ['class A {\n  static constructor() {}\n}', 'constructors cannot be static'],
    ['class A {\n  constructor() number {}\n}', 'constructors cannot have result types'],
    ['class A {\n  private public x number\n}', 'duplicate visibility modifier'],
    ['class A {\n  x, y number = 0\n}', 'a value can only be given to a single field'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });

  it('keeps parsing members after an error', () => {
    const { program, diagnostics } = parse('class A {\n  x number = )\n  y number\n}');
    expect(diagnostics.map((d) => d.message)).toEqual(['expected expression, found ")"']);
    expect((program.body[0] as ast.ClassDeclaration).members.map(describeMember)).toEqual([
      'FieldDeclaration public y number',
    ]);
  });
});
