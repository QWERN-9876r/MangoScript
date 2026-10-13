import type * as ast from '../ast.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { componentStyle, unmatchedSelectors } from '../styles.ts';
import type { ComponentInfo } from './context.ts';
import { isUntyped } from './helpers.ts';
import { RefChecker } from './refs.ts';
import { isAssignable, typeToString, widenLiterals } from './types.ts';

// `style { ... }` of components and decorators: the values from code are strings or numbers, the
// CSS is well formed, and a selector that matches no element of the markup is a warning. Warnings
// do not stop compilation.

export abstract class StyleChecker extends RefChecker {
  protected readonly warnings: Diagnostic[] = [];

  protected warn(message: string, node: ast.NodeBase): void {
    this.warnings.push({ message, start: node.start, end: node.end });
  }

  /** The values of a `style` block; checked after the body, so they see all its names. */
  protected override checkStyle(node: ast.StyleStatement): void {
    for (const part of node.parts) {
      if (part.kind === 'CssText') continue;

      const type = this.checkValue(part);
      const kind = widenLiterals(type).kind;

      if (!isUntyped(type) && kind !== 'string' && kind !== 'number') {
        this.error(`a value in CSS is a string or a number, not ${typeToString(type)}`, part);
      }
    }
  }

  protected override checkComponentBody(info: ComponentInfo): void {
    super.checkComponentBody(info);

    const { node } = info;
    const style = this.checkStyles(node.name.name, node.body, node.name.name);

    // The values become CSS variables of the element at the top of what the component creates.
    if (style && style.variables.size > 0) {
      const result = this.componentResult(info, new Set());

      if (!isUntyped(result) && isAssignable(this.dom.fragment, result)) {
        this.error(
          `values from code in the style of ${node.name.name} are set on the element it returns, so it cannot return ${typeToString(result)}`,
          node.name,
        );
      }
    }
  }

  /** The CSS of the `style` blocks of a component or a decorator, named `owner` in warnings. */
  protected checkStyles(
    name: string,
    body: ast.BlockStatement,
    owner: string,
  ): ReturnType<typeof componentStyle> {
    const style = componentStyle(name, body);

    if (!style) return null;
    for (const problem of style.problems) this.error(problem.message, problem);
    for (const unmatched of unmatchedSelectors(style, body)) {
      this.warn(`selector "${unmatched.selector}" matches no element of ${owner}`, unmatched);
    }

    return style;
  }
}
