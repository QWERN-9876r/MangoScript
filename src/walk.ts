import type * as ast from './ast.ts';

/** Calls `visit` for each direct child of `node`, in source order. */
export function forEachChild(node: ast.Node, visit: (child: ast.Node) => void): void {
  const each = (nodes: readonly ast.Node[]) => {
    for (const child of nodes) visit(child);
  };
  const optional = (child: ast.Node | null) => {
    if (child) visit(child);
  };

  switch (node.kind) {
    case 'Program':
    case 'BlockStatement':
      each(node.body);
      break;
    case 'ImportDeclaration':
      optional(node.defaultImport);
      optional(node.namespaceImport);
      each(node.namedImports);
      visit(node.source);
      break;
    case 'ImportSpecifier':
      visit(node.imported);
      if (node.local !== node.imported) visit(node.local);
      break;
    case 'FuncDeclaration':
    case 'MethodDeclaration':
      visit(node.name);
      each(node.params);
      each(node.results);
      visit(node.body);
      break;
    case 'Parameter':
      visit(node.name);
      optional(node.type);
      break;
    case 'VariableDeclaration':
      each(node.names);
      optional(node.type);
      each(node.values);
      break;
    case 'ClassDeclaration':
      visit(node.name);
      optional(node.superClass);
      each(node.implements);
      each(node.members);
      break;
    case 'FieldDeclaration':
      visit(node.name);
      optional(node.type);
      optional(node.value);
      break;
    case 'ConstructorDeclaration':
      each(node.params);
      visit(node.body);
      break;
    case 'InterfaceDeclaration':
      visit(node.name);
      each(node.members);
      break;
    case 'TypeAliasDeclaration':
      visit(node.name);
      visit(node.type);
      break;
    case 'ExpressionStatement':
      visit(node.expression);
      break;
    case 'AssignmentStatement':
      each(node.targets);
      each(node.values);
      break;
    case 'IncDecStatement':
      visit(node.target);
      break;
    case 'ReturnStatement':
      each(node.values);
      break;
    case 'IfStatement':
      visit(node.condition);
      visit(node.consequent);
      optional(node.alternate);
      break;
    case 'ForStatement':
      optional(node.init);
      optional(node.condition);
      optional(node.update);
      visit(node.body);
      break;
    case 'ForInStatement':
      optional(node.key);
      visit(node.value);
      visit(node.iterable);
      visit(node.body);
      break;
    case 'SwitchStatement':
      optional(node.discriminant);
      each(node.cases);
      break;
    case 'SwitchCase':
      each(node.tests);
      each(node.body);
      break;
    case 'ThrowStatement':
      visit(node.argument);
      break;
    case 'TryStatement':
      visit(node.block);
      optional(node.handler);
      optional(node.finalizer);
      break;
    case 'CatchClause':
      optional(node.param);
      visit(node.body);
      break;
    case 'DeferStatement':
      visit(node.body);
      break;
    case 'TemplateLiteral':
      node.quasis.forEach((quasi, i) => {
        visit(quasi);
        optional(node.expressions[i] ?? null);
      });
      break;
    case 'ArrayLiteral':
      each(node.elements);
      break;
    case 'ObjectLiteral':
      each(node.properties);
      break;
    case 'Property':
      visit(node.key);
      visit(node.value);
      break;
    case 'SpreadElement':
      visit(node.argument);
      break;
    case 'FuncExpression':
      each(node.params);
      each(node.results);
      visit(node.body);
      break;
    case 'ArrowFunction':
      each(node.params);
      visit(node.body);
      break;
    case 'UnaryExpression':
      visit(node.argument);
      break;
    case 'BinaryExpression':
      visit(node.left);
      visit(node.right);
      break;
    case 'ConditionalExpression':
      visit(node.test);
      visit(node.consequent);
      visit(node.alternate);
      break;
    case 'CallExpression':
    case 'NewExpression':
      visit(node.callee);
      each(node.arguments);
      break;
    case 'MemberExpression':
      visit(node.object);
      visit(node.property);
      break;
    case 'IndexExpression':
      visit(node.object);
      visit(node.index);
      break;
    case 'ElementExpression':
      optional(node.tag);
      each(node.attributes);
      each(node.children);
      break;
    case 'JsxExpressionContainer':
      visit(node.expression);
      break;
    case 'JsxAttribute':
      visit(node.name);
      optional(node.value);
      break;
    case 'JsxSpreadAttribute':
      visit(node.argument);
      break;
    case 'EventHandler':
      each(node.body);
      break;
    case 'TypeReference':
      visit(node.name);
      break;
    case 'ArrayType':
      visit(node.element);
      break;
    case 'NullableType':
      visit(node.type);
      break;
    case 'FuncType':
      each(node.params);
      each(node.results);
      break;
    case 'ObjectType':
      each(node.members);
      break;
    case 'PropertySignature':
      visit(node.name);
      visit(node.type);
      break;
    case 'MethodSignature':
      visit(node.name);
      each(node.params);
      each(node.results);
      break;
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'JsxText':
    case 'Identifier':
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'TemplateElement':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'ThisExpression':
    case 'SuperExpression':
      break;
  }
}

/** Names assigned anywhere inside `node`: `x = ...`, `x += ...`, `x++`. */
export function assignedNames(node: ast.Node, names = new Set<string>()): Set<string> {
  if (node.kind === 'AssignmentStatement') {
    for (const target of node.targets) if (target.kind === 'Identifier') names.add(target.name);
  } else if (node.kind === 'IncDecStatement' && node.target.kind === 'Identifier') {
    names.add(node.target.name);
  }
  forEachChild(node, (child) => assignedNames(child, names));
  return names;
}

/** Whether a `break` in these statements leaves the enclosing loop or switch. */
export function containsBreak(statements: readonly ast.Statement[]): boolean {
  let found = false;
  const visit = (node: ast.Node): void => {
    switch (node.kind) {
      case 'BreakStatement':
        found = true;
        return;
      // A `break` inside these belongs to them.
      case 'ForStatement':
      case 'ForInStatement':
      case 'SwitchStatement':
      case 'FuncDeclaration':
      case 'FuncExpression':
      case 'ArrowFunction':
      case 'ClassDeclaration':
        return;
      default:
        forEachChild(node, visit);
    }
  };
  statements.forEach(visit);
  return found;
}
