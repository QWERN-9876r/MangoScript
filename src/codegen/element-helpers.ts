import type * as ast from '../ast.ts';
import type { Type } from '../checker/types.ts';
import { forEachChild } from '../walk.ts';

// Types and small functions of markup code generation.

/** What can be inside markup: children of an element, or statements of a markup block. */
export type Content = ast.JsxChild | ast.Statement;

export type ControlStatement = ast.JsxStatementContainer['statement'];

/** `onClick` → `click`, `onKeyDown` → `keydown`; JSX spells `dblclick` as `onDoubleClick`. */
export function eventName(attribute: string): string {
  return attribute === 'onDoubleClick' ? 'dblclick' : attribute.slice(2).toLowerCase();
}

/** How a child expression is appended: as is, spread, after a null check, or by $$append. */
export function contentKind(
  node: ast.Expression,
  type: Type | undefined,
): 'value' | 'list' | 'nullable' | 'unknown' {
  if (type === undefined) {
    // Without types only literals are known for sure.
    return node.kind === 'StringLiteral' ||
      node.kind === 'NumberLiteral' ||
      node.kind === 'TemplateLiteral'
      ? 'value'
      : 'unknown';
  }

  switch (type.kind) {
    case 'string':
    case 'number':
    case 'object':
    case 'class':
      return 'value';

    case 'array':
      return isPlainContent(type.element) ? 'list' : 'unknown';

    case 'nullable':
      return isPlainContent(type.type) ? 'nullable' : 'unknown';

    default:
      return 'unknown';
  }
}

export function isPlainContent(type: Type): boolean {
  return (
    type.kind === 'string' ||
    type.kind === 'number' ||
    type.kind === 'object' ||
    type.kind === 'class'
  );
}

/** Whether a name is used inside a node, e.g. `event` in a handler. */
export function mentions(node: ast.Node, name: string): boolean {
  let found = false;
  const visit = (child: ast.Node): void => {
    if (found) return;
    if (child.kind === 'Identifier' && child.name === name) found = true;
    else if (child.kind === 'MemberExpression') visit(child.object);
    else forEachChild(child, visit);
  };

  visit(node);

  return found;
}
