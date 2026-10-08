import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as ast from '../src/ast.ts';
import { parse } from '../src/parser/parser.ts';
import { errors, first, inFunction, statements, sx } from './parser-helpers.ts';

// The parser: modules, statements and recovery from errors.

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
