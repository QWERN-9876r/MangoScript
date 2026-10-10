import type * as ast from '../ast.ts';
import { decoratedName } from '../decorators.ts';
import { forEachChild } from '../walk.ts';

// What code reads: the names of values, and the variable a change goes into.

/** The variable at the start of `a.b[i].c()`, or `null`. */
export function rootName(node: ast.Expression): string | null {
  switch (node.kind) {
    case 'Identifier':
      return node.name;

    case 'MemberExpression':
    case 'IndexExpression':
      return rootName(node.object);

    case 'CallExpression':
      return rootName(node.callee);

    case 'DecoratorGet':
      return rootName(node.target);

    case 'DecoratorMember':
      return decoratedName(node.decorator.name, node.member.name);

    default:
      return null;
  }
}

/** Names whose values a node reads, not counting code that runs on events. */
export function readNames(node: ast.Node, names: Set<string>): void {
  switch (node.kind) {
    case 'Identifier':
      names.add(node.name);

      return;

    case 'DecoratorMember':
      names.add(decoratedName(node.decorator.name, node.member.name));

      return;

    case 'MemberExpression':
      readNames(node.object, names);

      return;

    case 'Property':
      readNames(node.value, names);

      return;

    case 'ElementExpression':
      for (const attribute of node.attributes) readNames(attribute, names);
      for (const child of node.children) readNames(child, names);

      return;

    case 'JsxAttribute':
      if (node.value !== null && !/^on[A-Z]/.test(node.name.name)) readNames(node.value, names);

      return;

    // Both run later, when the markup exists.
    case 'EventHandler':
    case 'MountStatement':
      return;

    default:
      forEachChild(node, (child) => readNames(child, names));
  }
}
