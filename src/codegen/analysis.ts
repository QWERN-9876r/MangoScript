import type * as ast from '../ast.ts';
import { forEachChild } from '../walk.ts';

// Questions about the syntax tree that the generator asks before writing code.

export type BindingKind =
  'let' | 'const' | 'state' | 'param' | 'function' | 'class' | 'import' | 'loop' | 'catch';

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

/** Every name declared inside a component: its properties and all its local declarations. */
export function namesDeclaredIn(component: ast.ComponentDeclaration): Set<string> {
  const names = new Set<string>();
  const visit = (node: ast.Node): void => {
    switch (node.kind) {
      case 'Parameter':
        names.add(node.name.name);
        break;
      case 'VariableDeclaration':
        for (const name of node.names) names.add(name.name);
        break;
      case 'FuncDeclaration':
      case 'ClassDeclaration':
        names.add(node.name.name);
        break;
      case 'ForInStatement':
        names.add(node.value.name);
        if (node.key) names.add(node.key.name);
        break;
      case 'CatchClause':
        if (node.param) names.add(node.param.name);
        break;
      case 'EventHandler':
        names.add('event');
        break;
      default:
        break;
    }
    forEachChild(node, visit);
  };
  component.params.forEach(visit);
  visit(component.body);
  return names;
}

/** Whether markup appears in an expression, not counting nested functions (they handle theirs). */
export function containsElement(node: ast.Node): boolean {
  let found = false;
  const visit = (child: ast.Node): void => {
    if (found) return;
    if (child.kind === 'ElementExpression') {
      found = true;
      return;
    }
    if (child.kind === 'FuncExpression' || child.kind === 'ArrowFunction') return;
    forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Whether a member chain has `?.` somewhere: then the rest of it may not be evaluated. */
export function hasOptionalLink(node: ast.Expression): boolean {
  switch (node.kind) {
    case 'MemberExpression':
    case 'IndexExpression':
      return node.optional || hasOptionalLink(node.object);
    case 'CallExpression':
      return node.optional || hasOptionalLink(node.callee);
    default:
      return false;
  }
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
    case 'ComponentDeclaration':
      node.params.forEach(visit);
      visit(node.body);
      return;
    case 'ElementExpression':
      // Tags are not values.
      node.attributes.forEach(visit);
      node.children.forEach(visit);
      return;
    case 'JsxAttribute':
      visit(node.value);
      return;
    case 'Parameter':
      visit(node.defaultValue);
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

/** The variable at the start of `a.b.c`, or `null`. */
export function rootName(node: ast.Expression): string | null {
  if (node.kind === 'Identifier') return node.name;
  return node.kind === 'MemberExpression' ? rootName(node.object) : null;
}

/** Literals, which can be put into inlined code as they are. */
export function isConstant(node: ast.Expression): boolean {
  switch (node.kind) {
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
      return true;
    case 'TemplateLiteral':
      return node.expressions.length === 0;
    case 'UnaryExpression':
      return node.operator === '-' && node.argument.kind === 'NumberLiteral';
    default:
      return false;
  }
}

/** Expressions without side effects, which may be evaluated more than once. */
export function isSimple(node: ast.Expression): boolean {
  switch (node.kind) {
    case 'Identifier':
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'ThisExpression':
      return true;
    case 'MemberExpression':
      return isSimple(node.object);
    default:
      return false;
  }
}
