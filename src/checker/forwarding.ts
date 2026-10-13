import type * as ast from '../ast.ts';
import { attrsParam, attrsSpreads, attrsTarget } from '../attrs.ts';
import { isComponentUse, type Repeated } from '../refs.ts';
import { isSvgElement } from '../svg.ts';
import type { ComponentInfo } from './context.ts';
import { MarkupChecker } from './markup.ts';
import type { ObjectType } from './types.ts';

// Attributes passed on: `...attrs`, the last property of a component, takes the attributes of a
// use that are not properties, and `{...attrs}` puts them on one element of the component. A use
// is checked as if they were written on that element.

/** The type of `attrs` in the body: it can only be spread. */
export const ATTRIBUTES: ObjectType = {
  kind: 'object',
  name: 'Attributes',
  members: new Map(),
  call: null,
};

const WHERE: Record<Repeated, string> = {
  for: '{for}',
  if: '{if}',
  switch: '{switch}',
  expression: 'an expression',
  function: 'a function',
  block: 'a block of the body',
};

export abstract class ForwardingChecker extends MarkupChecker {
  /**
   * An attribute of a use that is not a property: checked as an attribute of the element that
   * `{...attrs}` is spread on. False when the component takes no attributes.
   */
  protected checkForwarded(attribute: ast.JsxAttribute, info: ComponentInfo, tag: string): boolean {
    if (!attrsParam(info.node)) return false;

    const target = attrsTarget(info.node);
    const name = attribute.name.name;
    const { value } = attribute;

    // The component itself reports a missing spread.
    if (!target?.tag) return true;
    if (name.startsWith('bind:')) {
      this.error(`${name} does not go through the attributes of <${tag}>`, attribute.name);
    } else if ((name === 'class' || name === 'style') && value !== null) {
      // They are added to those of the element, so they cannot change.
      if (value.kind !== 'StringLiteral') {
        this.error(
          `${name} passed to <${tag}> is added to that of its element, so it is a string: ${name}="..."`,
          value,
        );
      }
    } else {
      const element = target.tag.name;
      const svg = isSvgElement(element, false);

      this.checkAttribute(attribute, element, this.elementOf(element, svg), svg);
    }

    return true;
  }

  /** `...attrs` is spread on one element of markup the component creates once. */
  protected checkAttrsSpreads(info: ComponentInfo): void {
    const param = attrsParam(info.node);

    if (!param) return;

    const name = param.name.name;
    const spreads = attrsSpreads(info.node);

    if (info.node.htmlTag) {
      this.error(`a web component cannot take ...${name}: its attributes are its own`, param);
    } else if (spreads.length === 0) {
      this.error(
        `...${name} is not spread on an element; put it among the attributes of one, e.g. <button {...${name}}>`,
        param,
      );
    }

    spreads.forEach(({ attribute, element, repeated }, i) => {
      if (isComponentUse(element)) {
        this.error(
          `{...${name}} goes on an element, not on <${element.tag!.name}>: the attributes are those of an element`,
          attribute,
        );
      } else if (repeated !== null) {
        this.error(
          `{...${name}} is inside ${WHERE[repeated]}, which may create the element more than once; spread it on an element the component creates once`,
          attribute,
        );
      } else if (i > 0) {
        this.error(
          `...${name} is spread on another element already: the attributes go to one element`,
          attribute,
        );
      }
    });
  }
}
