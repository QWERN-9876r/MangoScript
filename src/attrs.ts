import type * as ast from './ast.ts';
import { isComponentUse, markupBindings, type MarkupBinding } from './refs.ts';

// Attributes passed on: `comp Button(kind Kind, ...attrs)` takes the attributes of a use that are
// not its properties, and `<button {...attrs}>` puts them on one of its elements. The use is
// checked against that element, and its code sets them there, on whichever element the component
// creates. The checker and the generator share these questions about the syntax tree.

/** `...attrs` of a component, its last parameter, or null. */
export function attrsParam(component: ast.ComponentDeclaration): ast.Parameter | null {
  return component.params.at(-1)?.rest ? component.params.at(-1)! : null;
}

/** Where a component spreads its `...attrs`, with whether that markup is created once. */
export function attrsSpreads(
  component: ast.ComponentDeclaration,
): MarkupBinding<ast.JsxSpreadAttribute>[] {
  const param = attrsParam(component);

  if (!param) return [];

  return markupBindings(
    component.body,
    (attribute): attribute is ast.JsxSpreadAttribute =>
      attribute.kind === 'JsxSpreadAttribute' &&
      attribute.argument.kind === 'Identifier' &&
      attribute.argument.name === param.name.name,
  );
}

/** The element that gets the attributes: the first one `{...attrs}` is spread on. */
export function attrsTarget(component: ast.ComponentDeclaration): ast.ElementExpression | null {
  const [spread] = attrsSpreads(component);

  return spread && !isComponentUse(spread.element) && spread.element.tag ? spread.element : null;
}
