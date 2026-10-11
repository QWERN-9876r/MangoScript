import type * as ast from './ast.ts';
import { decorate, type DecoratorSource, moduleNamesOf } from './decorators.ts';
import { freeNames, topLevelNames } from './names.ts';
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

/**
 * The packages of the exported components of a module that other modules can inline. A component
 * that is recursive or a web component cannot be inlined, and neither can one that reaches
 * components or decorators the module imports: those would bring the names of a third module.
 */
export function inlinePackages(program: ast.Program): Map<string, InlinePackage> {
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
  const packages = new Map<string, InlinePackage>();

  for (const [name, node] of components) {
    if (!node.exported || node.htmlTag || recursive.has(expanded.get(name)!)) continue;

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
    const visit = (current: string): boolean => {
      if (found.components.has(current)) return true;

      const component = components.get(current)!;

      found.components.set(current, component);
      for (const use of component.decorators) {
        const source = sources.get(use.name.name);

        if (!source) return false;
        found.decorators.set(use.name.name, source);
        sort(freeNames(source.node), false);
      }

      sort(freeNames(withArguments(component)), true);
      for (const tag of tagsIn(expanded.get(current)!)) {
        if (components.has(tag)) {
          if (isFunction(tag)) found.functions.set(tag, components.get(tag)!);
          else if (!visit(tag)) return false;
        } else if (topLevel.has(tag)) {
          return false;
        }
      }

      return true;
    };

    if (!visit(name)) continue;
    found.moduleNames = [...own].sort();
    found.globals = [...globals].sort();
    packages.set(name, found);
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
