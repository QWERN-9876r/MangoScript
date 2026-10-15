import type * as ast from './ast.ts';

// The children of types and of the members of object types, for forEachChild (walk.ts).

type TypeChildNode = ast.TypeNode | ast.TypeMember | ast.TypeParameter;

export function forEachTypeChild(node: TypeChildNode, visit: (child: ast.Node) => void): void {
  const each = (nodes: readonly ast.Node[]) => {
    for (const child of nodes) visit(child);
  };
  const optional = (child: ast.Node | null) => {
    if (child) visit(child);
  };

  switch (node.kind) {
    case 'TypeReference':
      visit(node.name);
      each(node.typeArgs);
      break;

    case 'TypeParameter':
      visit(node.name);
      optional(node.constraint);
      break;

    case 'ArrayType':
    case 'ChanType':
      visit(node.element);
      break;

    case 'NullableType':
      visit(node.type);
      break;

    case 'FuncType':
      each(node.params);
      each(node.results);
      break;

    case 'ComponentType':
      each(node.params);
      break;

    case 'ObjectType':
      each(node.members);
      break;

    case 'UnionType':
      each(node.types);
      break;

    case 'LiteralType':
      visit(node.value);
      break;

    case 'PropertySignature':
      visit(node.name);
      visit(node.type);
      break;

    case 'IndexSignature':
      visit(node.key);
      visit(node.type);
      break;

    case 'MethodSignature':
      visit(node.name);
      each(node.params);
      each(node.results);
      break;
  }
}
