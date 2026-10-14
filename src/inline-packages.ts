import type * as ast from './ast.ts';
import { decorate, type DecoratorSource, moduleNamesOf } from './decorators.ts';
import { assignedNames, componentValues, freeNames, topLevelNames } from './names.ts';
import { recursiveComponents } from './recursion.ts';
import { forEachChild } from './walk.ts';

// Inlining a component in another module. Its module exports the function of the component, and
// also what another module needs to inline it instead: the components of its module that it
// reaches, and the names of its module that their code uses, through hidden exports
// (`export { PREFIX as $$Card$PREFIX }`). The module that uses it chooses between the two by the
// same threshold as for its own components.

export interface InlinePackage {
  /** The exported component first, then the components of its module it reaches: inlined too. */
  components: Map<string, ast.ComponentDeclaration>;
  /** Reached components that are functions in their module (recursive, web or exported): called. */
  functions: Map<string, ast.ComponentDeclaration>;
  /** The decorators of the module applied to them, with the names of the module their code uses. */
  decorators: Map<string, DecoratorSource>;
  /** The names of the module that the components' own code uses. */
  moduleNames: string[];
  /** Names the code uses that the module does not declare: they must mean the same elsewhere. */
  globals: string[];
}

/** The packages that a module exports for others. */
export interface ModulePackages {
  /** By exported component; a component that cannot be inlined has none. */
  components: Map<string, InlinePackage>;
  /**
   * By exported decorator: the components its code uses, which go with it into the components it
   * is applied to. Null when they cannot go elsewhere.
   */
  decorators: Map<string, InlinePackage | null>;
}

/**
 * The packages of the exported components and decorators of a module. A component that is
 * recursive or a web component cannot be inlined, and neither can one that reaches components or
 * decorators the module imports: those would bring the names of a third module. Nor can code that
 * uses a component of the module as a value, which is the function in the module, or that assigns
 * a variable of the module: another module could only read it.
 */
export function inlinePackages(program: ast.Program): ModulePackages {
  const components = new Map<string, ast.ComponentDeclaration>();
  const decorators = new Map<string, ast.DecoratorDeclaration>();

  for (const statement of program.body) {
    if (statement.kind === 'ComponentDeclaration') components.set(statement.name.name, statement);
    if (statement.kind === 'DecoratorDeclaration') decorators.set(statement.name.name, statement);
  }

  const sources = new Map(
    [...decorators].map(([name, node]): [string, DecoratorSource] => [
      name,
      { node, moduleNames: moduleNamesOf(node, program) },
    ]),
  );
  const expanded = new Map(
    [...components].map(([name, node]) => [name, decorate(node, sources)] as const),
  );
  const recursive = recursiveComponents(expanded);
  const isFunction = (name: string) => {
    const node = components.get(name)!;

    return node.htmlTag !== null || node.exported || recursive.has(expanded.get(name)!);
  };
  const topLevel = topLevelNames(program);
  const usesComponentValues = (node: ast.Node) =>
    componentValues(node, (name) => components.has(name)).length > 0;
  const assignsModuleNames = (node: ast.ComponentDeclaration) => {
    const assigned = assignedNames(node);

    return [...freeNames(node)].some((name) => topLevel.has(name) && assigned.has(name));
  };

  /** The package of a component, or of the tags in the code of a decorator. */
  const build = (root: string | null, tags: Iterable<string>): InlinePackage | null => {
    const found: InlinePackage = {
      components: new Map(),
      functions: new Map(),
      decorators: new Map(),
      moduleNames: [],
      globals: [],
    };
    const own = new Set<string>();
    const globals = new Set<string>();
    const sort = (names: Iterable<string>, mine: boolean) => {
      for (const used of names) {
        if (!topLevel.has(used)) globals.add(used);
        else if (mine) own.add(used);
      }
    };
    // A component of the module is called or inlined; one the module imports cannot go anywhere.
    const take = (tag: string): boolean => {
      if (!components.has(tag)) return !topLevel.has(tag);
      if (!isFunction(tag)) return visit(tag);
      found.functions.set(tag, components.get(tag)!);

      return true;
    };
    const visit = (current: string): boolean => {
      if (found.components.has(current)) return true;

      const component = components.get(current)!;

      found.components.set(current, component);
      if (usesComponentValues(expanded.get(current)!)) return false;
      if (assignsModuleNames(expanded.get(current)!)) return false;
      for (const use of component.decorators) {
        const source = sources.get(use.name.name);

        if (!source) return false;
        found.decorators.set(use.name.name, source);
        sort(freeNames(source.node), false);
      }

      sort(freeNames(withArguments(component)), true);

      return [...tagsIn(expanded.get(current)!)].every(take);
    };

    if (!(root === null ? [...tags].every(take) : visit(root))) return null;
    found.moduleNames = [...own].sort();
    found.globals = [...globals].sort();

    return found;
  };

  const packages: ModulePackages = { components: new Map(), decorators: new Map() };

  for (const [name, node] of components) {
    if (!node.exported || node.htmlTag || recursive.has(expanded.get(name)!)) continue;

    const found = build(name, []);

    if (found) packages.components.set(name, found);
  }

  for (const [name, node] of decorators) {
    if (!node.exported) continue;
    packages.decorators.set(
      name,
      usesComponentValues(node) ? null : build(null, tagsIn(node.body)),
    );
  }

  return packages;
}

/** The component's own code with the arguments of its decorators, which are its code too. */
function withArguments(component: ast.ComponentDeclaration) {
  const statements = component.decorators.flatMap((use) =>
    use.arguments.map((expression): ast.Statement => ({
      kind: 'ExpressionStatement',
      expression,
      start: use.start,
      end: use.end,
    })),
  );

  return {
    params: component.params,
    body: { ...component.body, body: [...statements, ...component.body.body] },
  };
}

/** The names of components in the markup: tags with a capital letter. */
function tagsIn(node: ast.Node): Set<string> {
  const tags = new Set<string>();
  const visit = (child: ast.Node): void => {
    if (child.kind === 'ElementExpression' && child.tag && /^[A-Z]/.test(child.tag.name)) {
      tags.add(child.tag.name);
    }

    forEachChild(child, visit);
  };

  visit(node);

  return tags;
}
