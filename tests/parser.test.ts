import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as ast from '../src/ast.ts';
import { parse } from '../src/parser/parser.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────

function statements(source: string): ast.Statement[] {
  const { program, diagnostics } = parse(source);
  expect(diagnostics).toEqual([]);
  return program.body;
}

/** The first statement, checked to be of the given kind. */
function first<K extends ast.Statement['kind']>(
  source: string,
  kind: K,
): Extract<ast.Statement, { kind: K }> {
  const [statement] = statements(source);
  expect(statement?.kind).toBe(kind);
  return statement as Extract<ast.Statement, { kind: K }>;
}

/** Statements of a function body, for statements that are only allowed inside functions. */
function inFunction(source: string): ast.Statement[] {
  return first(`func f() {\n${source}\n}`, 'FuncDeclaration').body.body;
}

function expr(source: string): ast.Expression {
  return first(`x = ${source}`, 'AssignmentStatement').values[0]!;
}

function errors(source: string): string[] {
  return parse(source).diagnostics.map((d) => d.message);
}

/** An expression as an S-expression: `a + b * c` → `(+ a (* b c))`. */
function sx(node: ast.Expression | ast.SpreadElement | ast.Property): string {
  switch (node.kind) {
    case 'Identifier':
      return node.name;
    case 'NumberLiteral':
    case 'StringLiteral':
      return node.raw;
    case 'BooleanLiteral':
      return String(node.value);
    case 'NullLiteral':
      return 'null';
    case 'ThisExpression':
      return 'this';
    case 'SuperExpression':
      return 'super';
    case 'TemplateLiteral': {
      const parts = node.quasis.flatMap((quasi, i) => {
        const expression = node.expressions[i];
        return expression
          ? [JSON.stringify(quasi.raw), sx(expression)]
          : [JSON.stringify(quasi.raw)];
      });
      return `(\` ${parts.join(' ')})`;
    }
    case 'ArrayLiteral':
      return `[${node.elements.map(sx).join(' ')}]`;
    case 'ObjectLiteral':
      return `{${node.properties.map(sx).join(' ')}}`;
    case 'Property':
      return node.shorthand ? sx(node.value) : `${sx(node.key)}: ${sx(node.value)}`;
    case 'SpreadElement':
      return `(... ${sx(node.argument)})`;
    case 'FuncExpression':
      return `(func (${node.params.map(param).join(' ')})${results(node.results)} {...})`;
    case 'ArrowFunction': {
      const body = node.body.kind === 'BlockStatement' ? '{...}' : sx(node.body);
      return `(=> (${node.params.map(param).join(' ')}) ${body})`;
    }
    case 'UnaryExpression':
      return `(${node.operator} ${sx(node.argument)})`;
    case 'BinaryExpression':
      return `(${node.operator} ${sx(node.left)} ${sx(node.right)})`;
    case 'ConditionalExpression':
      return `(? ${sx(node.test)} ${sx(node.consequent)} ${sx(node.alternate)})`;
    case 'CallExpression':
      return `(${node.optional ? '?call' : 'call'} ${[node.callee, ...node.arguments].map(sx).join(' ')})`;
    case 'NewExpression':
      return `(new ${[node.callee, ...node.arguments].map(sx).join(' ')})`;
    case 'MemberExpression':
      return `(${node.optional ? '?.' : '.'} ${sx(node.object)} ${node.property.name})`;
    case 'IndexExpression':
      return `(${node.optional ? '?[]' : '[]'} ${sx(node.object)} ${sx(node.index)})`;
    case 'ElementExpression':
      return `<${node.tag?.name ?? ''}>`;
  }
}

/** A type in MangoScript syntax. */
function ty(node: ast.TypeNode): string {
  switch (node.kind) {
    case 'TypeReference':
      return node.name.name;
    case 'ArrayType':
      return `[]${ty(node.element)}`;
    case 'NullableType':
      return `?${ty(node.type)}`;
    case 'FuncType':
      return `func(${node.params.map(ty).join(', ')})${results(node.results)}`;
    case 'ObjectType':
      return `{ ${node.members.map(member).join('; ')} }`;
    case 'UnionType':
      return `(${node.types.map(ty).join(' | ')})`;
    case 'LiteralType':
      return node.value.kind === 'StringLiteral' ? node.value.raw : String(node.value.value);
  }
}

function member(node: ast.TypeMember): string {
  return node.kind === 'PropertySignature'
    ? `${node.name.name} ${ty(node.type)}`
    : `${node.name.name}(${node.params.map(param).join(', ')})${results(node.results)}`;
}

function param(node: ast.Parameter): string {
  return node.type ? `${node.name.name} ${ty(node.type)}` : node.name.name;
}

function results(types: ast.TypeNode[]): string {
  if (types.length === 0) return '';
  if (types.length === 1) return ` ${ty(types[0]!)}`;
  return ` (${types.map(ty).join(', ')})`;
}

// ─── Expressions ─────────────────────────────────────────────────────────────────────────────────

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

describe('modules', () => {
  const summary = (node: ast.ImportDeclaration): string => {
    const names = node.namedImports.map((s) =>
      s.imported === s.local ? s.local.name : `${s.imported.name} as ${s.local.name}`,
    );
    const clauses = [
      node.defaultImport?.name,
      node.namespaceImport && `* as ${node.namespaceImport.name}`,
      names.length > 0 && `{ ${names.join(', ')} }`,
    ].filter(Boolean);
    return [clauses.join(', '), clauses.length > 0 && 'from', node.source.raw]
      .filter(Boolean)
      .join(' ');
  };

  it.each([
    'import "./setup.mango"',
    'import express from "express"',
    'import * as path from "node:path"',
    'import { readFileSync, writeFileSync as write } from "node:fs"',
    'import { default as main } from "./main.mango"',
    'import React, { useState } from "react"',
    'import fs, * as all from "node:fs"',
  ])('%s', (source) => {
    expect(summary(first(source, 'ImportDeclaration'))).toBe(source.slice('import '.length));
  });

  it('marks exported declarations', () => {
    const body = statements(
      'export func f() {}\nexport const x = 1\nexport class A {}\nexport interface I {}\nexport type T string\nfunc g() {}',
    );
    expect(body.map((node) => 'exported' in node && node.exported)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it.each([
    ['func f() {\n  import "x"\n}', 'imports are only allowed at the top level of a module'],
    ['if ok {\n  export const a = 1\n}', '"export" is only allowed at the top level of a module'],
    ['export x = 1', 'expected a declaration after "export", found "x"'],
    ['import { default } from "x"', '"default" is a keyword: rename it with "as"'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

// ─── Statements ──────────────────────────────────────────────────────────────────────────────────

describe('simple statements', () => {
  it('parses assignments', () => {
    expect(first('a, b = b, a', 'AssignmentStatement')).toMatchObject({
      operator: '=',
      targets: [{ name: 'a' }, { name: 'b' }],
      values: [{ name: 'b' }, { name: 'a' }],
    });
    expect(first('total += v', 'AssignmentStatement').operator).toBe('+=');
    expect(first('user.name = "Ann"', 'AssignmentStatement').targets.map(sx)).toEqual([
      '(. user name)',
    ]);
    expect(first('xs[i] = 1', 'AssignmentStatement').targets.map(sx)).toEqual(['([] xs i)']);
  });

  it('parses increments', () => {
    expect(first('i++', 'IncDecStatement')).toMatchObject({
      operator: '++',
      target: { name: 'i' },
    });
  });

  it.each([
    ['f() = 1', 'cannot assign to this expression'],
    ['a?.b = 1', 'cannot assign to this expression'],
    ['a, b += 1, 2', '"+=" works with a single variable'],
    ['x = i++', '"++" is a statement and cannot be used inside an expression'],
    ['++i', '"++" must follow the variable: "i++"'],
    ['a + b', 'this expression does nothing: only function calls can be used as statements'],
    ['x := 1', '":=" is not supported: declare variables with "let" or "const"'],
    ['a, b := f()', '":=" is not supported: declare variables with "let" or "const"'],
    ['function f() {}', '"function" is not a MangoScript keyword: declare functions with "func"'],
    ['f() g()', 'expected newline or ";" after statement, found "g"'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('if', () => {
  it('parses else-if chains', () => {
    const node = first(
      'if x > 0 {\n  a()\n} else if x < 0 {\n  b()\n} else {\n  c()\n}',
      'IfStatement',
    );
    expect(sx(node.condition)).toBe('(> x 0)');
    expect(node.alternate).toMatchObject({
      kind: 'IfStatement',
      alternate: { kind: 'BlockStatement' },
    });
  });

  it('allows a one-line block', () => {
    expect(first('if ok { run() }', 'IfStatement').consequent.body).toHaveLength(1);
  });

  it('requires else on the same line as }', () => {
    expect(errors('if x {\n}\nelse {\n}')).toEqual([
      '"else" must be on the same line as the closing "}"',
    ]);
  });

  it('requires parentheses around object literals in the condition', () => {
    expect(errors('if p == { x: 1 } {\n}')).toEqual([
      'expected expression, found "{" (wrap object literals in parentheses here)',
    ]);
    expect(errors('if p == ({ x: 1 }) {\n}')).toEqual([]);
    expect(errors('if eq(p, { x: 1 }) {\n}')).toEqual([]);
  });
});

describe('for', () => {
  it('parses all loop forms', () => {
    expect(first('for {}', 'ForStatement')).toMatchObject({
      init: null,
      condition: null,
      update: null,
    });
    expect(sx(first('for running {}', 'ForStatement').condition!)).toBe('running');

    const classic = first('for let i = 0; i < n; i++ {}', 'ForStatement');
    expect(classic.init?.kind).toBe('VariableDeclaration');
    expect(sx(classic.condition!)).toBe('(< i n)');
    expect(classic.update?.kind).toBe('IncDecStatement');

    expect(first('for x in xs {}', 'ForInStatement')).toMatchObject({
      key: null,
      value: { name: 'x' },
      iterable: { name: 'xs' },
    });
    expect(first('for i, x in items {}', 'ForInStatement')).toMatchObject({
      key: { name: 'i' },
      value: { name: 'x' },
    });
  });

  it('reports one error for a Go-style header', () => {
    expect(errors('for i := 0; i < 3; i++ {\n  f(i)\n}\ng()')).toEqual([
      '":=" is not supported: declare variables with "let" or "const"',
    ]);
  });
});

describe('switch', () => {
  it('parses cases and default', () => {
    const node = first(
      'switch cmd {\ncase "start", "run":\n  start()\ncase "stop":\n  stop()\n  break\ndefault:\n  help()\n}',
      'SwitchStatement',
    );
    expect(sx(node.discriminant!)).toBe('cmd');
    expect(node.cases.map((c) => c.tests.map(sx))).toEqual([['"start"', '"run"'], ['"stop"'], []]);
    expect(node.cases.map((c) => c.body.length)).toEqual([1, 2, 1]);
  });

  it('parses switch without a discriminant', () => {
    const node = first('switch {\ncase x > 0:\n  a()\n}', 'SwitchStatement');
    expect(node.discriminant).toBeNull();
    expect(sx(node.cases[0]!.tests[0]!)).toBe('(> x 0)');
  });

  it('reports a second default', () => {
    expect(errors('switch x {\ndefault:\ndefault:\n}')).toEqual([
      'multiple "default" cases in switch',
    ]);
  });
});

describe('statements inside functions', () => {
  it('parses return with several values', () => {
    expect(inFunction('return q, null')).toMatchObject([
      { kind: 'ReturnStatement', values: [{ name: 'q' }, { kind: 'NullLiteral' }] },
    ]);
    expect(inFunction('return')).toMatchObject([{ kind: 'ReturnStatement', values: [] }]);
  });

  it('parses try/catch/finally', () => {
    expect(inFunction('try {\n  a()\n} catch e {\n  b()\n} finally {\n  c()\n}')).toMatchObject([
      {
        kind: 'TryStatement',
        handler: { param: { name: 'e' } },
        finalizer: { kind: 'BlockStatement' },
      },
    ]);
    expect(inFunction('try {\n} catch {\n}')).toMatchObject([
      { kind: 'TryStatement', handler: { param: null }, finalizer: null },
    ]);
  });

  it('parses defer', () => {
    expect(inFunction('defer f.close()')).toMatchObject([
      { kind: 'DeferStatement', body: { kind: 'CallExpression' } },
    ]);
    expect(inFunction('defer {\n  a()\n}')).toMatchObject([
      { kind: 'DeferStatement', body: { kind: 'BlockStatement' } },
    ]);
  });

  it('parses throw', () => {
    expect(inFunction('throw error("boom")')).toMatchObject([
      { kind: 'ThrowStatement', argument: { kind: 'CallExpression' } },
    ]);
  });

  it.each([
    ['return 1', '"return" outside of a function'],
    ['defer f()', '"defer" outside of a function'],
    ['break', '"break" outside of a loop or switch'],
    ['for x in xs {\n  func() {\n    continue\n  }()\n}', '"continue" outside of a loop'],
    ['func f() {\n  defer x\n}', '"defer" needs a function call or a block'],
    ['func f() {\n  defer {\n    return\n  }\n}', '"return" is not allowed inside "defer"'],
    ['func f() {\n  try {\n  }\n}', '"try" needs a "catch" or "finally" block'],
    ['func f() {\n  try {\n  } catch (e) {\n  }\n}', 'write "catch e {" without parentheses'],
    [
      'func f() {\n  try {\n  }\n  catch e {\n  }\n}',
      '"catch" must be on the same line as the closing "}"',
    ],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

// ─── Error recovery ──────────────────────────────────────────────────────────────────────────────

describe('error recovery', () => {
  it('reports errors in several statements and keeps parsing', () => {
    const { program, diagnostics } = parse('let = 1\nlet y = 2\nconst z = )\nfunc ok() {}');
    expect(diagnostics.map((d) => d.message)).toEqual([
      'expected variable name, found "="',
      'expected expression, found ")"',
    ]);
    expect(program.body.map((s) => s.kind)).toEqual(['VariableDeclaration', 'FuncDeclaration']);
  });

  it('stops at the end of the enclosing block after an unclosed bracket', () => {
    const { program, diagnostics } = parse(
      'func f() {\n  let x = (1 +\n  return 2\n}\nfunc g() {}',
    );
    expect(diagnostics.map((d) => d.message)).toEqual(['expected expression, found "return"']);
    expect(program.body.map((s) => s.kind)).toEqual(['FuncDeclaration', 'FuncDeclaration']);
  });

  it('skips a stray closing brace', () => {
    const { program, diagnostics } = parse('}\nf()');
    expect(diagnostics.map((d) => d.message)).toEqual(['expected expression, found "}"']);
    expect(program.body.map((s) => s.kind)).toEqual(['ExpressionStatement']);
  });

  it('includes lexer errors', () => {
    expect(errors('x = 1 === 1')).toEqual(['"===" is not needed: "==" is already strict']);
  });
});

it('parses examples/hello.mango', () => {
  const source = readFileSync(new URL('../examples/hello.mango', import.meta.url), 'utf8');
  const { program, diagnostics } = parse(source);
  expect(diagnostics).toEqual([]);
  expect(program.body.map((s) => s.kind)).toEqual([
    'InterfaceDeclaration',
    'ClassDeclaration',
    'FuncDeclaration',
    'FuncDeclaration',
    'FuncDeclaration',
    'FuncDeclaration',
    'ExpressionStatement',
    'ExpressionStatement',
    'ExpressionStatement',
  ]);
});
