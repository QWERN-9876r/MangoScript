import type * as ast from './ast.ts';
import { forEachChild } from './walk.ts';

// Components that use themselves, directly or through other components. They cannot be inlined,
// so they become functions. A cycle of uses also needs a use under a condition, or the recursion
// never ends.

export interface ComponentUse {
  tag: ast.Identifier;
  /**
   * Inside if/for/switch, a branch of `?:`, the right side of `&&`, `||` or `??`, a function, or
   * a default value of a property: the use may not run every time the component is created.
   */
  conditional: boolean;
}

/** Tags with a capital letter inside a component: uses of other components, or of itself. */
export function componentUses(component: ast.ComponentDeclaration): ComponentUse[] {
  const uses: ComponentUse[] = [];
  const visit = (node: ast.Node, conditional: boolean): void => {
    const visitChildren = (inside: boolean) => forEachChild(node, (child) => visit(child, inside));
    switch (node.kind) {
      case 'ElementExpression':
        if (node.tag && /^[A-Z]/.test(node.tag.name)) uses.push({ tag: node.tag, conditional });
        for (const attribute of node.attributes) visit(attribute, conditional);
        for (const child of node.children) visit(child, conditional);
        return;
      case 'IfStatement':
        visit(node.condition, conditional);
        visit(node.consequent, true);
        if (node.alternate) visit(node.alternate, true);
        return;
      case 'ConditionalExpression':
        visit(node.test, conditional);
        visit(node.consequent, true);
        visit(node.alternate, true);
        return;
      case 'BinaryExpression':
        if (node.operator === '&&' || node.operator === '||' || node.operator === '??') {
          visit(node.left, conditional);
          visit(node.right, true);
          return;
        }
        visitChildren(conditional);
        return;
      case 'ForStatement':
      case 'ForInStatement':
      case 'SwitchStatement':
      case 'CatchClause':
      case 'FuncDeclaration':
      case 'FuncExpression':
      case 'ArrowFunction':
      case 'EventHandler':
      case 'ClassDeclaration':
      case 'Parameter':
        visitChildren(true);
        return;
      default:
        visitChildren(conditional);
    }
  };
  for (const param of component.params) visit(param, true);
  // After an early return the rest of the body may not run.
  let returned = false;
  for (const statement of component.body.body) {
    visit(statement, returned);
    returned ||= containsReturn(statement);
  }
  return uses;
}

/** Whether a statement has a `return` of its own, not one of a nested function. */
export function containsReturn(statement: ast.Statement): boolean {
  let found = false;
  const visit = (node: ast.Node): void => {
    if (found) return;
    switch (node.kind) {
      case 'ReturnStatement':
        found = true;
        return;
      case 'FuncDeclaration':
      case 'FuncExpression':
      case 'ArrowFunction':
      case 'EventHandler':
      case 'ClassDeclaration':
        return;
      default:
        forEachChild(node, visit);
    }
  };
  visit(statement);
  return found;
}

/** Components that can reach themselves through their uses. */
export function recursiveComponents(
  components: ReadonlyMap<string, ast.ComponentDeclaration>,
): Set<ast.ComponentDeclaration> {
  const edges = new Map<ast.ComponentDeclaration, ast.ComponentDeclaration[]>();
  for (const component of components.values()) {
    const used = componentUses(component)
      .map((use) => components.get(use.tag.name))
      .filter((other): other is ast.ComponentDeclaration => other !== undefined);
    edges.set(component, used);
  }
  const recursive = new Set<ast.ComponentDeclaration>();
  for (const component of components.values()) {
    const seen = new Set<ast.ComponentDeclaration>();
    const stack = [...(edges.get(component) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next === component) {
        recursive.add(component);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(edges.get(next) ?? []));
    }
  }
  return recursive;
}

export interface EndlessRecursion {
  /** Names of the components on the cycle, starting and ending with the same one. */
  cycle: string[];
  /** The use that closes the cycle. */
  tag: ast.Identifier;
}

/** Cycles of uses where every use runs each time: creating such a component never ends. */
export function endlessRecursion(
  components: ReadonlyMap<string, ast.ComponentDeclaration>,
): EndlessRecursion[] {
  const edges = new Map<
    ast.ComponentDeclaration,
    { to: ast.ComponentDeclaration; tag: ast.Identifier }[]
  >();
  for (const component of components.values()) {
    const list: { to: ast.ComponentDeclaration; tag: ast.Identifier }[] = [];
    for (const use of componentUses(component)) {
      const to = components.get(use.tag.name);
      if (to && !use.conditional) list.push({ to, tag: use.tag });
    }
    edges.set(component, list);
  }
  const found: EndlessRecursion[] = [];
  const state = new Map<ast.ComponentDeclaration, 'visiting' | 'done'>();
  const visit = (component: ast.ComponentDeclaration, path: ast.ComponentDeclaration[]): void => {
    state.set(component, 'visiting');
    for (const edge of edges.get(component) ?? []) {
      if (state.get(edge.to) === 'visiting') {
        const cycle = [...path.slice(path.indexOf(edge.to)), edge.to];
        found.push({ cycle: cycle.map((c) => c.name.name), tag: edge.tag });
      } else if (!state.has(edge.to)) {
        visit(edge.to, [...path, edge.to]);
      }
    }
    state.set(component, 'done');
  };
  for (const component of components.values()) {
    if (!state.has(component)) visit(component, [component]);
  }
  return found;
}

/** What a component returns: the markup of every `return` of its own, in order. */
export function returnedMarkup(component: ast.ComponentDeclaration): ast.Expression[] {
  const found: ast.Expression[] = [];
  const visit = (node: ast.Node): void => {
    switch (node.kind) {
      case 'ReturnStatement':
        found.push(...node.values);
        return;
      case 'FuncDeclaration':
      case 'FuncExpression':
      case 'ArrowFunction':
      case 'EventHandler':
      case 'ClassDeclaration':
        return;
      default:
        forEachChild(node, visit);
    }
  };
  visit(component.body);
  return found;
}
