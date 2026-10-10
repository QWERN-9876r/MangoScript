import type * as ast from './ast.ts';

// Copies of a decorator's code for the components it is applied to, with its names renamed.

/** Called with each copy of a node, so that the generator keeps the types of the originals. */
export type CopyListener = (copy: ast.Node, original: ast.Node) => void;

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

const TYPE_NODES: ReadonlySet<string> = new Set([
  'TypeReference',
  'ArrayType',
  'NullableType',
  'FuncType',
  'ObjectType',
  'UnionType',
  'LiteralType',
  'TypeParameter',
  'PropertySignature',
  'MethodSignature',
]);

function isNode(value: unknown): value is ast.Node {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

/**
 * Copies nodes of a decorator, renaming its names where a local declaration does not hide them.
 * Names of properties, attributes, tags and types are left as they are.
 */
export function renamer(
  renames: ReadonlyMap<string, string>,
  copied: CopyListener | undefined,
): <T extends ast.Node>(node: T, hidden: ReadonlySet<string>) => T {
  const done = <T extends ast.Node>(copy: T, original: ast.Node): T => {
    copied?.(copy, original);

    return copy;
  };
  const statements = (list: readonly ast.Statement[], hidden: ReadonlySet<string>) => {
    const inner = new Set([...hidden, ...declaredIn(list)]);

    return list.map((statement) => copy(statement, inner));
  };
  const scoped = (names: readonly string[], hidden: ReadonlySet<string>) =>
    new Set([...hidden, ...names]);
  const paramNames = (params: readonly ast.Parameter[]) => params.map((param) => param.name.name);

  const generic = <T extends ast.Node>(node: T, hidden: ReadonlySet<string>): T => {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        result[key] = value.map((item: unknown) => (isNode(item) ? copy(item, hidden) : item));
      } else {
        result[key] = isNode(value) ? copy(value, hidden) : value;
      }
    }

    return done(result as unknown as T, node);
  };

  const copy = <T extends ast.Node>(original: T, hidden: ReadonlySet<string>): T => {
    const node: ast.Node = original;

    if (TYPE_NODES.has(node.kind)) return original;
    switch (node.kind) {
      // The names of `@cart.count` are the other decorator's.
      case 'DecoratorMember':
        return original;

      case 'Identifier': {
        const name = hidden.has(node.name) ? undefined : renames.get(node.name);

        return name === undefined ? original : done({ ...node, name } as T, node);
      }

      case 'MemberExpression':
        return done({ ...node, object: copy(node.object, hidden) } as T, node);

      case 'Property': {
        const value = copy(node.value, hidden);
        // `{ shown }` becomes `{ shown: $$visible$shown }`.
        const shorthand = node.shorthand && value === node.value;

        return done({ ...node, value, shorthand } as T, node);
      }

      case 'JsxAttribute':
        return done({ ...node, value: node.value && copy(node.value, hidden) } as T, node);

      case 'ElementExpression':
        return done(
          {
            ...node,
            attributes: node.attributes.map((attribute) => copy(attribute, hidden)),
            children: node.children.map((child) => copy(child, hidden)),
          } as T,
          node,
        );

      case 'MethodDeclaration': {
        const inner = scoped(paramNames(node.params), hidden);

        return done(
          {
            ...node,
            params: node.params.map((param) => copy(param, inner)),
            body: copy(node.body, inner),
          } as T,
          node,
        );
      }

      case 'FieldDeclaration':
        return done({ ...node, value: node.value && copy(node.value, hidden) } as T, node);

      case 'FuncDeclaration':
      case 'FuncExpression':
      case 'ArrowFunction':
      case 'ConstructorDeclaration': {
        const inner = scoped(paramNames(node.params), hidden);
        const renamed = generic(node, inner);

        // The name of a declared function is in the enclosing scope.
        if (node.kind === 'FuncDeclaration') {
          (renamed as ast.FuncDeclaration).name = copy(node.name, hidden);
        }

        return renamed as T;
      }

      case 'Parameter':
        return done(
          { ...node, defaultValue: node.defaultValue && copy(node.defaultValue, hidden) } as T,
          node,
        );

      case 'BlockStatement':
        return done({ ...node, body: statements(node.body, hidden) } as T, node);

      case 'SwitchCase':
        return done(
          {
            ...node,
            tests: node.tests.map((test) => copy(test, hidden)),
            body: statements(node.body, hidden),
          } as T,
          node,
        );

      case 'EventHandler':
        return done({ ...node, body: statements(node.body, scoped(['event'], hidden)) } as T, node);

      case 'ForInStatement': {
        const names = [node.value.name, ...(node.key ? [node.key.name] : [])];

        return done(
          {
            ...node,
            iterable: copy(node.iterable, hidden),
            body: copy(node.body, scoped(names, hidden)),
          } as T,
          node,
        );
      }

      case 'ForStatement':
        return generic(node, scoped(node.init ? declaredIn([node.init]) : [], hidden)) as T;

      case 'CatchClause':
        return done(
          {
            ...node,
            body: copy(node.body, scoped(node.param ? [node.param.name] : [], hidden)),
          } as T,
          node,
        );

      default:
        return generic(original, hidden);
    }
  };

  return copy;
}
