import { holdsRules, type CssDeclaration, type CssNode } from './parse.ts';

// CSS back as text, two spaces per level, with selectors and values given by the caller.

export interface PrintOptions {
  /** The selector of a rule; not called inside `@keyframes`, whose selectors are steps. */
  selector: (selector: string) => string;
  value: (declaration: CssDeclaration) => string;
}

export function printCss(nodes: readonly CssNode[], options: PrintOptions): string {
  const lines: string[] = [];
  const print = (list: readonly CssNode[], indent: string, steps: boolean): void => {
    for (const node of list) {
      switch (node.kind) {
        case 'declaration':
          lines.push(`${indent}${node.property}: ${options.value(node)};`);
          break;

        case 'rule':
          lines.push(`${indent}${steps ? node.selector : options.selector(node.selector)} {`);
          print(node.body, `${indent}  `, steps);
          lines.push(`${indent}}`);
          break;

        case 'at-rule': {
          const head = `${indent}@${node.name}${node.prelude ? ` ${node.prelude}` : ''}`;

          if (node.body === null) {
            lines.push(`${head};`);
            break;
          }

          lines.push(`${head} {`);
          // The rules of @media keep their selectors; @keyframes has steps, @font-face none.
          print(node.body, `${indent}  `, steps || !holdsRules(node));
          lines.push(`${indent}}`);
        }
      }
    }
  };

  print(nodes, '', false);

  return lines.join('\n');
}

/** The text of a value with its values from code given by `slot`. */
export function valueText(declaration: CssDeclaration, slot: (index: number) => string): string {
  return declaration.value.map((part) => (typeof part === 'number' ? slot(part) : part)).join('');
}
