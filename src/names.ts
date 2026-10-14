import type * as ast from './ast.ts';
import { forEachChild } from './walk.ts';

// The names that code inside a node assigns, mentions or declares, and those it uses from outside.

/** Names assigned anywhere inside `node`: `x = ...`, `x += ...`, `x++`. */
export function assignedNames(node: ast.Node, names = new Set<string>()): Set<string> {
  if (node.kind === 'AssignmentStatement') {
    for (const target of node.targets) if (target.kind === 'Identifier') names.add(target.name);
  } else if (node.kind === 'IncDecStatement' && node.target.kind === 'Identifier') {
    names.add(node.target.name);
  } else if (
    node.kind === 'JsxAttribute' &&
    node.name.name.startsWith('bind:') &&
    node.value?.kind === 'Identifier'
  ) {
    // `bind:value={name}` writes what the user enters.
    names.add(node.value.name);
  }

  forEachChild(node, (child) => assignedNames(child, names));

  return names;
}

/** Whether an identifier with one of `names` occurs in `node`, whatever it refers to. */
export function mentionsName(node: ast.Node, names: ReadonlySet<string>): boolean {
  if (node.kind === 'Identifier') return names.has(node.name);

  let found = false;

  forEachChild(node, (child) => {
    found ||= mentionsName(child, names);
  });

  return found;
}

/** Every name declared inside `node`: parameters and all local declarations, nested ones too. */
export function declaredNames(node: ast.Node): Set<string> {
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

  forEachChild(node, visit);

  return names;
}

/** Names a component or a decorator uses as values but does not declare: those come from the module. */
export function freeNames(component: {
  params: readonly ast.Parameter[];
  body: ast.BlockStatement;
}): Set<string> {
  const used = new Set<string>();
  const declared = new Set<string>(component.params.map((param) => param.name.name));
  const visit = (node: ast.Node | null): void => {
    if (node === null) return;
    switch (node.kind) {
      case 'Identifier':
        used.add(node.name);

        return;

      case 'MemberExpression':
        visit(node.object);

        return;

      case 'Property':
        visit(node.value);

        return;

      case 'ElementExpression':
        // Tags are not values: components are found by the generator itself.
        node.attributes.forEach(visit);
        node.children.forEach(visit);

        return;

      case 'JsxAttribute':
        visit(node.value);

        return;

      case 'EventHandler':
        declared.add('event');
        node.body.forEach(visit);

        return;

      case 'VariableDeclaration':
        for (const name of node.names) declared.add(name.name);
        node.values.forEach(visit);

        return;

      case 'FuncDeclaration':
      case 'ClassDeclaration':
        declared.add(node.name.name);
        forEachChild(node, visit);

        return;

      case 'Parameter':
        declared.add(node.name.name);
        visit(node.defaultValue);

        return;

      case 'ForInStatement':
        declared.add(node.value.name);
        if (node.key) declared.add(node.key.name);
        visit(node.iterable);
        visit(node.body);

        return;

      case 'CatchClause':
        if (node.param) declared.add(node.param.name);
        visit(node.body);

        return;

      case 'TypeReference':
      case 'ArrayType':
      case 'NullableType':
      case 'FuncType':
      case 'ComponentType':
      case 'ObjectType':
      case 'UnionType':
      case 'LiteralType':
      case 'TypeParameter':
        return;

      default:
        forEachChild(node, visit);
    }
  };

  component.params.forEach(visit);
  visit(component.body);

  return new Set([...used].filter((name) => !declared.has(name)));
}

/** Names declared directly in a list of statements: they hide outer names in the whole block. */
export function declaredIn(statements: readonly ast.Statement[]): string[] {
  return statements.flatMap((statement) => {
    switch (statement.kind) {
      case 'VariableDeclaration':
        return statement.names.map((name) => name.name);

      case 'FuncDeclaration':
      case 'ClassDeclaration':
        return [statement.name.name];

      default:
        return [];
    }
  });
}

/** Names declared at the top level of a module, imports included: what its code can use. */
export function topLevelNames(program: ast.Program): Set<string> {
  const names = new Set(declaredIn(program.body));

  for (const statement of program.body) {
    if (statement.kind !== 'ImportDeclaration') continue;
    if (statement.defaultImport) names.add(statement.defaultImport.name);
    if (statement.namespaceImport) names.add(statement.namespaceImport.name);
    for (const specifier of statement.namedImports) names.add(specifier.local.name);
  }

  return names;
}

/**
 * Names used as values, as opposed to declared names, property names and types. A capitalized tag
 * is a value unless `isComponent` says it names a component: `<Page />` with a variable `Page`.
 */
export function collectValueNames(
  node: ast.Node,
  names: Set<string>,
  isComponent: (name: string) => boolean = () => true,
): void {
  const visit = (child: ast.Node | null) => {
    if (child) collectValueNames(child, names, isComponent);
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
      node.decorators.forEach(visit);
      node.params.forEach(visit);
      visit(node.body);

      return;

    case 'DecoratorDeclaration':
      node.params.forEach(visit);
      visit(node.body);

      return;

    case 'ElementExpression':
      // Tags are not values, except those that take a component from one.
      visit(node.value);
      if (node.value === null && node.tag && /^[A-Z]/.test(node.tag.name)) {
        if (!isComponent(node.tag.name)) names.add(node.tag.name);
      }

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
    case 'ComponentType':
    case 'ObjectType':
    case 'UnionType':
    case 'LiteralType':
    case 'TypeParameter':
      return;

    default:
      forEachChild(node, visit);
  }
}

/** The components that the code in `node` uses as values: `content: Intro`. */
export function componentValues(node: ast.Node, isComponent: (name: string) => boolean): string[] {
  const values = new Set<string>();

  collectValueNames(node, values, isComponent);

  return [...values].filter(isComponent);
}
