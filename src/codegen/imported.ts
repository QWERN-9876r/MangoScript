import type * as ast from '../ast.ts';
import type { Type } from '../checker/types.ts';
import { type CopyListener, renamer } from '../decorator-copy.ts';
import { decorate, decoratedName } from '../decorators.ts';
import type { InlinePackage } from '../inline-packages.ts';

// Components of other modules in the module that uses them. Each is called, or inlined with what
// its package brings (inline-packages.ts). Inlined code keeps referring to its own module: its
// names come through hidden imports, `PREFIX` as `$$Box$PREFIX` for `import { Card as Box }`, its
// components get tags of their own, `<Box$Icon />`, and its decorators prefixes, `$$Box$visible$`.

export interface ImportedComponent {
  node: ast.ComponentDeclaration;
  /** What inlining needs; null when the component can only be called. */
  inline: InlinePackage | null;
  /** The types of the expressions of its module. */
  types: WeakMap<ast.Expression, Type> | null;
}

/** An inlined component of another module, with the components it brings, by their tags here. */
export interface LocalizedPackage {
  inline: Map<string, ast.ComponentDeclaration>;
  /** Components it calls, with the names of their functions here. */
  functions: Map<string, { node: ast.ComponentDeclaration; name: string }>;
  /** The hidden names it imports: as exported there, as named here. */
  imports: [string, string][];
}

/** The package of a component imported as `name`, ready to be inlined here. */
export function localize(
  name: string,
  imported: ImportedComponent,
  copied: CopyListener,
): LocalizedPackage {
  const found = imported.inline!;
  const root = imported.node.name.name;
  const tag = (other: string) => (other === root ? name : `${name}$${other}`);
  const tags = new Map(
    [...found.components.keys(), ...found.functions.keys()].map((other) => [other, tag(other)]),
  );
  const prefixes = new Map(
    [...found.decorators.keys()].map((other) => [other, `${name}$${other}`]),
  );
  const renames = new Map(found.moduleNames.map((used) => [used, decoratedName(name, used)]));
  const copy = renamer(renames, copied, { tags, decorators: prefixes });
  const inline = new Map<string, ast.ComponentDeclaration>();
  const functions = new Map<string, { node: ast.ComponentDeclaration; name: string }>();

  // Here the copy is not exported: it is inlined like a component of this module.
  for (const [other, node] of found.components) {
    const component = copy(decorate(node, found.decorators, copied, prefixes), new Set());

    inline.set(tag(other), { ...component, exported: false });
  }

  // A copy of its own: the same component may be imported here directly too.
  for (const [other, node] of found.functions) {
    functions.set(tag(other), { node: { ...node }, name: `$$${tag(other)}` });
  }

  const imports: [string, string][] = [
    ...found.moduleNames.map((used): [string, string] => [
      decoratedName(root, used),
      decoratedName(name, used),
    ]),
    ...[...found.decorators].flatMap(([other, source]) =>
      source.moduleNames.map((used): [string, string] => [
        decoratedName(other, used),
        decoratedName(prefixes.get(other)!, used),
      ]),
    ),
    ...[...found.functions.keys()].map((other): [string, string] => [
      `$$${other}`,
      `$$${tag(other)}`,
    ]),
  ];

  return { inline, functions, imports };
}

/**
 * `export { PREFIX as $$Card$PREFIX }` and the like: what the modules that inline the exported
 * components of this one import from it, by the name they are exported under.
 */
export function packageExports(
  packages: ReadonlyMap<string, InlinePackage>,
  jsName: (name: string) => string,
): Map<string, string> {
  const exports = new Map<string, string>();

  for (const [root, found] of packages) {
    for (const used of found.moduleNames) exports.set(decoratedName(root, used), jsName(used));
    for (const [other, source] of found.decorators) {
      for (const used of source.moduleNames) {
        exports.set(decoratedName(other, used), jsName(used));
      }
    }

    // An exported component's function is exported already.
    for (const [other, node] of found.functions) {
      if (!node.exported) exports.set(`$$${other}`, `$$${other}`);
    }
  }

  return exports;
}
