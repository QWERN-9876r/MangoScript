import type * as ast from './ast.ts';
import { hash } from './css/hash.ts';
import { parseCss, SLOT, type CssDeclaration, type CssNode, type CssProblem } from './css/parse.ts';
import { holdsRules } from './css/parse.ts';
import { printCss, valueText } from './css/print.ts';
import { requirements, scopeSelector, splitComplex, splitList } from './css/selectors.ts';
import { forEachChild } from './walk.ts';

// `style { ... }` of components and decorators: the class that their elements get, the CSS with
// that class in the selectors, and the values from code, which become CSS variables set on the
// element at the top of the component's markup. The checker and the generator share these.

export interface ComponentStyle {
  /** `mango-product-card-1x9k2az`: the class of the elements of the component's own markup. */
  scope: string;
  nodes: CssNode[];
  /** Problems of the CSS, with offsets in the source of the module. */
  problems: CssProblem[];
  /** The values from code, in the order they are numbered in the declarations. */
  values: ast.Expression[];
  /** Declarations with values from code and the CSS variables they become. */
  variables: Map<CssDeclaration, string>;
  /** The offset in the source of an offset in the parsed text. */
  sourceOffset: (offset: number) => number;
}

/** The `style` blocks at the top level of the body of a component or a decorator. */
export function styleBlocks(body: ast.BlockStatement): ast.StyleStatement[] {
  return body.body.filter((statement) => statement.kind === 'StyleStatement');
}

/** The style of a component or a decorator, or null if it has no `style` block. */
export function componentStyle(name: string, body: ast.BlockStatement): ComponentStyle | null {
  const blocks = styleBlocks(body);

  if (blocks.length === 0) return null;

  // The blocks as one text, values from code as SLOT; `segments` map it back to the source.
  let text = '';
  const segments: { at: number; offset: number }[] = [];
  const values: ast.Expression[] = [];

  for (const block of blocks) {
    for (const part of block.parts) {
      segments.push({ at: text.length, offset: part.start });
      if (part.kind === 'CssText') {
        text += part.value;
      } else {
        text += SLOT;
        values.push(part);
      }
    }

    text += '\n';
  }

  const sourceOffset = (offset: number) => {
    const segment = segments.findLast((each) => each.at <= offset) ?? { at: 0, offset: 0 };

    return segment.offset + offset - segment.at;
  };
  const scope = `mango-${kebabCase(name)}-${hash(text)}`;
  const sheet = parseCss(text);
  const variables = new Map<CssDeclaration, string>();

  visitDeclarations(sheet.nodes, (declaration) => {
    if (declaration.value.some((part) => typeof part === 'number')) {
      variables.set(declaration, `--${scope}-${variables.size}`);
    }
  });

  return {
    scope,
    nodes: sheet.nodes,
    problems: sheet.problems.map((problem) => ({
      message: problem.message,
      start: sourceOffset(problem.start),
      end: sourceOffset(problem.end),
    })),
    values,
    variables,
    sourceOffset,
  };
}

/** The CSS of a style: the class of the component in the selectors, variables for the values. */
export function scopedCss(style: ComponentStyle): string {
  return printCss(style.nodes, {
    selector: (selector) => scopeSelector(selector, style.scope),
    value: (declaration) => {
      const variable = style.variables.get(declaration);

      return variable ? `var(${variable})` : valueText(declaration, () => '');
    },
  });
}

/** `ProductCard` → `product-card`. */
export function kebabCase(name: string): string {
  return name
    .replace(/[^\w-]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function visitDeclarations(nodes: readonly CssNode[], visit: (node: CssDeclaration) => void): void {
  for (const node of nodes) {
    if (node.kind === 'declaration') visit(node);
    else if (node.body) visitDeclarations(node.body, visit);
  }
}

/** Whether an element has a `class` attribute. */
export function hasClass(node: ast.ElementExpression): boolean {
  return node.attributes.some(
    (attribute) => attribute.kind === 'JsxAttribute' && attribute.name.name === 'class',
  );
}

/** What an element of the markup can match: its tag, its classes and id if they are known. */
interface MarkupElement {
  tag: string;
  /** Null when `class={...}` or a spread may give it any class. */
  classes: Set<string> | null;
  /** Undefined when it is not known. */
  id: string | null | undefined;
}

/** The elements of the markup of a body: those that get the class of its style. */
export function ownElements(body: ast.Node): ast.ElementExpression[] {
  const found: ast.ElementExpression[] = [];
  const visit = (node: ast.Node): void => {
    // The use of a component is not an element, but what is passed to it is the markup here.
    if (node.kind === 'ElementExpression' && node.tag && !/^[A-Z]/.test(node.tag.name)) {
      found.push(node);
    }

    forEachChild(node, visit);
  };

  visit(body);

  return found;
}

function describe(node: ast.ElementExpression): MarkupElement {
  let classes: Set<string> | null = new Set();
  let id: string | null | undefined = null;

  for (const attribute of node.attributes) {
    if (attribute.kind === 'JsxSpreadAttribute') {
      classes = null;
      id = undefined;
      continue;
    }

    const { name, value } = attribute;
    const text = value?.kind === 'StringLiteral' ? value.value : undefined;

    if (name.name === 'class' && classes !== null) {
      classes = text === undefined ? null : new Set(text.split(/\s+/).filter(Boolean));
    } else if (name.name === 'id') {
      id = text;
    }
  }

  return { tag: node.tag!.name.toLowerCase(), classes, id };
}

/**
 * Selectors of a style that no element of the markup of `body` can match: with a tag, a class or
 * an id that none of them has. Elements with `class={...}` may have any class.
 */
export function unmatchedSelectors(
  style: ComponentStyle,
  body: ast.Node,
): { selector: string; start: number; end: number }[] {
  const elements = ownElements(body).map(describe);
  const found: { selector: string; start: number; end: number }[] = [];
  const matches = (compound: string): boolean => {
    if (compound === '' || compound.includes('&') || compound.includes(':global(')) return true;

    const { tag, classes, ids } = requirements(compound);

    return elements.some(
      (element) =>
        (tag === null || tag.toLowerCase() === element.tag) &&
        (element.classes === null || classes.every((name) => element.classes!.has(name))) &&
        (element.id === undefined || ids.every((id) => id === element.id)),
    );
  };
  const visit = (nodes: readonly CssNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'rule') {
        for (const complex of splitList(node.selector)) {
          const compounds = splitComplex(complex).filter((_, i) => i % 2 === 0);

          if (!compounds.every(matches)) {
            found.push({
              selector: complex,
              start: style.sourceOffset(node.start),
              end: style.sourceOffset(node.end),
            });
          }
        }

        visit(node.body);
      } else if (node.kind === 'at-rule' && node.body && holdsRules(node)) {
        visit(node.body);
      }
    }
  };

  visit(style.nodes);

  return found;
}
