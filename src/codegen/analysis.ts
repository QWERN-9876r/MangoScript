import type * as ast from '../ast.ts';
import { forEachChild } from '../walk.ts';

// Questions about the syntax tree that the generator asks before writing code.

export type BindingKind =
  'let' | 'const' | 'param' | 'function' | 'class' | 'import' | 'loop' | 'catch';

/** Names declared directly in a list of statements. */
export function declarationsOf(statements: readonly ast.Statement[]): [string, BindingKind][] {
  const bindings: [string, BindingKind][] = [];
  for (const statement of statements) {
    switch (statement.kind) {
      case 'VariableDeclaration':
        for (const name of statement.names) bindings.push([name.name, statement.keyword]);
        break;
      case 'FuncDeclaration':
        bindings.push([statement.name.name, 'function']);
        break;
      case 'ClassDeclaration':
        bindings.push([statement.name.name, 'class']);
        break;
      case 'ImportDeclaration':
        if (statement.defaultImport) bindings.push([statement.defaultImport.name, 'import']);
        if (statement.namespaceImport) bindings.push([statement.namespaceImport.name, 'import']);
        for (const specifier of statement.namedImports) {
          bindings.push([specifier.local.name, 'import']);
        }
        break;
      default:
        break;
    }
  }
  return bindings;
}

/** `defer` statements of a function body, excluding those of nested functions. */
export function findDefers(body: ast.BlockStatement): ast.DeferStatement[] {
  const defers: ast.DeferStatement[] = [];
  const visit = (node: ast.Node): void => {
    switch (node.kind) {
      case 'DeferStatement':
        defers.push(node);
        return;
      case 'FuncDeclaration':
      case 'FuncExpression':
      case 'ArrowFunction':
      case 'ClassDeclaration':
        return;
      default:
        forEachChild(node, visit);
    }
  };
  forEachChild(body, visit);
  return defers;
}

export function endsWithJump(statements: readonly ast.Statement[]): boolean {
  const kind = statements.at(-1)?.kind;
  return (
    kind === 'ReturnStatement' ||
    kind === 'ThrowStatement' ||
    kind === 'BreakStatement' ||
    kind === 'ContinueStatement'
  );
}

export function startsWithObjectLiteral(node: ast.Expression): boolean {
  switch (node.kind) {
    case 'ObjectLiteral':
      return true;
    case 'CallExpression':
      return startsWithObjectLiteral(node.callee);
    case 'MemberExpression':
    case 'IndexExpression':
      return startsWithObjectLiteral(node.object);
    case 'BinaryExpression':
      return startsWithObjectLiteral(node.left);
    case 'ConditionalExpression':
      return startsWithObjectLiteral(node.test);
    default:
      return false;
  }
}

/** Names used as values, as opposed to declared names, property names and types. */
export function collectValueNames(node: ast.Node, names: Set<string>): void {
  const visit = (child: ast.Node | null) => {
    if (child) collectValueNames(child, names);
  };
  switch (node.kind) {
    case 'Identifier':
      names.add(node.name);
      return;
    case 'MemberExpression':
      visit(node.object);
      return;
    case 'Property':
      visit(node.value);
      return;
    case 'VariableDeclaration':
      node.values.forEach(visit);
      return;
    case 'FuncDeclaration':
    case 'MethodDeclaration':
    case 'ConstructorDeclaration':
    case 'FuncExpression':
    case 'ArrowFunction':
      visit(node.body);
      return;
    case 'ClassDeclaration':
      visit(node.superClass);
      node.members.forEach(visit);
      return;
    case 'FieldDeclaration':
      visit(node.value);
      return;
    case 'ForInStatement':
      visit(node.iterable);
      visit(node.body);
      return;
    case 'CatchClause':
      visit(node.body);
      return;
    case 'ImportDeclaration':
    case 'InterfaceDeclaration':
    case 'TypeAliasDeclaration':
    case 'Parameter':
    case 'TypeReference':
    case 'ArrayType':
    case 'NullableType':
    case 'FuncType':
    case 'ObjectType':
      return;
    default:
      forEachChild(node, visit);
  }
}
