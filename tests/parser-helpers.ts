import { expect } from 'vitest';
import type * as ast from '../src/ast.ts';
import { parse } from '../src/parser/parser.ts';

// Helpers of the parser tests: parsing snippets and printing syntax trees compactly.

export function statements(source: string): ast.Statement[] {
  const { program, diagnostics } = parse(source);

  expect(diagnostics).toEqual([]);

  return program.body;
}

/** The first statement, checked to be of the given kind. */
export function first<K extends ast.Statement['kind']>(
  source: string,
  kind: K,
): Extract<ast.Statement, { kind: K }> {
  const [statement] = statements(source);

  expect(statement?.kind).toBe(kind);

  return statement as Extract<ast.Statement, { kind: K }>;
}

/** Statements of a function body, for statements that are only allowed inside functions. */
export function inFunction(source: string): ast.Statement[] {
  return first(`func f() {\n${source}\n}`, 'FuncDeclaration').body.body;
}

export function expr(source: string): ast.Expression {
  return first(`x = ${source}`, 'AssignmentStatement').values[0]!;
}

export function errors(source: string): string[] {
  return parse(source).diagnostics.map((d) => d.message);
}

/** An expression as an S-expression: `a + b * c` → `(+ a (* b c))`. */
export function sx(node: ast.Expression | ast.SpreadElement | ast.Property): string {
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

    case 'DecoratorMember':
      return `@${node.decorator.name}.${node.member.name}`;

    case 'DecoratorGet':
      return `(get ${sx(node.target)})`;
  }
}

/** A type in MangoScript syntax. */
export function ty(node: ast.TypeNode): string {
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

export function member(node: ast.TypeMember): string {
  return node.kind === 'PropertySignature'
    ? `${node.name.name} ${ty(node.type)}`
    : `${node.name.name}(${node.params.map(param).join(', ')})${results(node.results)}`;
}

export function param(node: ast.Parameter): string {
  return node.type ? `${node.name.name} ${ty(node.type)}` : node.name.name;
}

export function results(types: ast.TypeNode[]): string {
  if (types.length === 0) return '';
  if (types.length === 1) return ` ${ty(types[0]!)}`;

  return ` (${types.map(ty).join(', ')})`;
}
