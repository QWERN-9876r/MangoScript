import type * as ast from './ast.ts';
import { forEachChild } from './walk.ts';

// SVG in markup. An element is created in the SVG namespace when it is `<svg>`, inside one, or a
// tag that only SVG has: so a component can return `<path>` to be put into an `<svg>`. The
// children of `<foreignObject>` are HTML again. Tags that both have (`a`, `title`, `style`,
// `script`) are SVG only inside `<svg>`.

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const SVG_ONLY: ReadonlySet<string> = new Set([
  'animate',
  'animateMotion',
  'animateTransform',
  'circle',
  'clipPath',
  'defs',
  'desc',
  'ellipse',
  'feBlend',
  'feColorMatrix',
  'feComposite',
  'feDropShadow',
  'feFlood',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feOffset',
  'filter',
  'foreignObject',
  'g',
  'image',
  'line',
  'linearGradient',
  'marker',
  'mask',
  'metadata',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialGradient',
  'rect',
  'stop',
  'symbol',
  'text',
  'textPath',
  'tspan',
  'use',
  'view',
]);

/** Whether `<tag>` is an SVG element, inside `<svg>` or not. */
export function isSvgElement(tag: string, inSvg: boolean): boolean {
  return tag === 'svg' || SVG_ONLY.has(tag) || (inSvg && !tag.includes('-'));
}

/** Whether the children of an element are inside SVG: those of `<foreignObject>` are HTML. */
export function childrenInSvg(tag: string | null, svg: boolean, inSvg: boolean): boolean {
  return tag === null ? inSvg : svg && tag !== 'foreignObject';
}

/** The SVG elements of the markup in `root`, for code that creates them out of their place. */
export function svgElements(root: ast.Node): Set<ast.ElementExpression> {
  const found = new Set<ast.ElementExpression>();
  const visit = (node: ast.Node, inSvg: boolean): void => {
    if (node.kind !== 'ElementExpression' || (node.tag && /^[A-Z]/.test(node.tag.name))) {
      forEachChild(node, (child) => visit(child, inSvg));

      return;
    }

    const tag = node.tag?.name ?? null;
    const svg = tag !== null && isSvgElement(tag, inSvg);

    if (svg) found.add(node);
    for (const attribute of node.attributes) visit(attribute, inSvg);
    for (const child of node.children) visit(child, childrenInSvg(tag, svg, inSvg));
  };

  visit(root, false);

  return found;
}
