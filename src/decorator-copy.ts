import type * as ast from './ast.ts';
import { declaredIn } from './names.ts';

// Copies of code that goes elsewhere, with its names renamed: of a decorator, for the components it
// is applied to, and of a component of another module, for the module that inlines it.

/** Called with each copy of a node, so that the generator keeps the types of the originals. */
export type CopyListener = (copy: ast.Node, original: ast.Node) => void;

/** The node each copy was made from. */
const origins = new WeakMap<ast.Node, ast.Node>();

/** The node in the code as written that `node` is a copy of, through copies of copies. */
export function originOf(node: ast.Node): ast.Node {
  let current = node;

  while (true) {
    const origin = origins.get(current);

    if (!origin) return current;
    current = origin;
  }
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
  'IndexSignature',
]);

function isNode(value: unknown): value is ast.Node {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

/**
 * Renames of the names that are not values: tags of components, `<Icon />`, and decorators,
 * `get(@visible.shown)`. Code of another module refers to those of its own module.
 */
export interface OtherNames {
  tags?: ReadonlyMap<string, string>;
  decorators?: ReadonlyMap<string, string>;
}

/**
 * Copies nodes, renaming names where a local declaration does not hide them. Names of properties,
 * attributes and types are left as they are, and so are tags and decorators without `other`.
 */
export function renamer(
  renames: ReadonlyMap<string, string>,
  copied: CopyListener | undefined,
  other: OtherNames = {},
): <T extends ast.Node>(node: T, hidden: ReadonlySet<string>) => T {
  const done = <T extends ast.Node>(copy: T, original: ast.Node): T => {
    origins.set(copy, original);
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
      case 'DecoratorMember': {
        const name = other.decorators?.get(node.decorator.name);

        return name === undefined
          ? original
          : done({ ...node, decorator: { ...node.decorator, name } } as T, node);
      }

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

      case 'ElementExpression': {
        const name = node.tag && other.tags?.get(node.tag.name);

        return done(
          {
            ...node,
            tag: name ? { ...node.tag!, name } : node.tag,
            attributes: node.attributes.map((attribute) => copy(attribute, hidden)),
            children: node.children.map((child) => copy(child, hidden)),
          } as T,
          node,
        );
      }

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
