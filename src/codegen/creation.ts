import type * as ast from '../ast.ts';
import { domProperty } from '../checker/dom.ts';
import { AttributeEmitter } from './attributes.ts';
import type { Live } from './reactive.ts';
import { ARROW } from './syntax.ts';

/**
 * The creation of elements. In a module that creates many of them (see ELEMENT_HELPER_LIMIT in
 * js.ts) an element is created by a helper together with the attributes it has from the start:
 * `$$element("a", { href: "/", className: "link" }, { "aria-label": label })` takes the place of
 * a `createElement` and a statement for each attribute. The first object holds properties, the
 * second attributes set with setAttribute; an SVG element has only attributes.
 */

/** Attributes given to the helper that creates an element, which need no statements of their own. */
export interface Creation {
  covered: Set<ast.JsxAttribute | ast.JsxSpreadAttribute>;
  /** Whether the class of the style is given too. */
  scoped: boolean;
}

/** A property or an attribute in the objects of the helper: `className: "card"`. */
interface Entry {
  attribute: boolean;
  key: string;
  value: string;
}

export abstract class CreationEmitter extends AttributeEmitter {
  /** The elements the code creates, counted where it creates them, not as often as it runs. */
  createdElements = 0;

  /**
   * Writes `declaration = <a new element>`. With the helper it is given the attributes before the
   * first spread, which may override them, except those that need more than a value: handlers,
   * `bind:`, styles, properties of web components and attributes that may be null. `scopeClass`
   * is the class of the style for an element without a class attribute.
   */
  protected createWith(
    declaration: string,
    element: string,
    tag: string,
    svg: boolean,
    attributes: readonly (ast.JsxAttribute | ast.JsxSpreadAttribute)[],
    live: Live | null,
    scope: string | null,
    scopeClass: string | null,
  ): Creation {
    const covered = new Set<ast.JsxAttribute | ast.JsxSpreadAttribute>();

    this.createdElements++;
    if (!this.options.elementHelper) {
      this.line(`${declaration} = ${this.createElement(tag, svg)};`);

      return { covered, scoped: false };
    }

    const entries: Entry[] = [];

    for (const attribute of attributes) {
      if (attribute.kind === 'JsxSpreadAttribute') break;

      const entry = this.entry(element, tag, attribute, live, svg, scope);

      if (entry) {
        entries.push(entry);
        covered.add(attribute);
      }
    }

    if (scopeClass !== null) {
      entries.push({
        attribute: svg,
        key: svg ? 'class' : 'className',
        value: JSON.stringify(scopeClass),
      });
    }

    const object = (attribute: boolean) => {
      const fields = entries
        .filter((entry) => entry.attribute === attribute)
        .map(({ key, value }) => {
          if (!/^[A-Za-z_$][\w$]*$/.test(key)) return `${JSON.stringify(key)}: ${value}`;

          return key === value ? key : `${key}: ${value}`;
        });

      return fields.length === 0 ? null : `{ ${fields.join(', ')} }`;
    };
    const properties = object(false);
    const attributesObject = object(true);
    const args = [JSON.stringify(tag)];

    if (svg) {
      this.helpers.add('svgElement');
      if (attributesObject) args.push(attributesObject);
      this.line(`${declaration} = $$svgElement(${args.join(', ')});`);
    } else {
      this.helpers.add('element');
      if (properties || attributesObject) args.push(properties ?? '{}');
      if (attributesObject) args.push(attributesObject);
      this.line(`${declaration} = $$element(${args.join(', ')});`);
    }

    return { covered, scoped: scopeClass !== null };
  }

  /** What `attribute()` would set, as an entry of the objects of the helper, if it is a value. */
  private entry(
    element: string,
    tag: string,
    attribute: ast.JsxAttribute,
    live: Live | null,
    svg: boolean,
    scope: string | null,
  ): Entry | null {
    const name = attribute.name.name;
    const { value } = attribute;

    if (name === 'ref' || name === 'style' || name.startsWith('bind:') || /^on[A-Z]/.test(name)) {
      return null;
    }

    if (value?.kind === 'EventHandler' || (!svg && this.webComponentProperty(tag, name))) {
      return null;
    }

    if (name === 'class' && scope) {
      const key = svg ? 'class' : 'className';

      if (value === null || value.kind === 'StringLiteral') {
        const classes = `${value?.value ?? ''} ${scope}`.trim();

        return { attribute: svg, key, value: JSON.stringify(classes) };
      }

      const nullable = this.typeOf(value)?.kind !== 'string';

      return this.valueEntry(element, svg, key, value, live, (text) => {
        return `\`\${${nullable ? `${text} ?? ""` : text}} ${scope}\``;
      });
    }

    // SVG attributes are set with setAttribute: their properties are objects.
    const property = svg ? null : domProperty(tag, name);

    if (value === null) {
      return property?.type.kind === 'bool'
        ? { attribute: false, key: property.name, value: 'true' }
        : { attribute: true, key: name, value: '""' };
    }

    if (property) return this.valueEntry(element, false, property.name, value, live);

    // A null value leaves the attribute out, which takes a statement.
    if (this.typeOf(value)?.kind === 'nullable') return null;

    return this.valueEntry(element, true, name, value, live);
  }

  /** An entry whose value may depend on state: then it is also set again on updates. */
  private valueEntry(
    element: string,
    attribute: boolean,
    key: string,
    value: ast.Expression,
    live: Live | null,
    wrap: (text: string) => string = (text) => text,
  ): Entry {
    const sources = live && value.kind !== 'StringLiteral' ? live.dependencies(value) : null;

    if (!live || !sources || sources.size === 0) {
      return { attribute, key, value: wrap(this.expression(value, ARROW)) };
    }

    const text = wrap(this.liveExpression(value));

    live.depend(
      sources,
      attribute
        ? `${element}.setAttribute(${JSON.stringify(key)}, ${text});`
        : `${element}.${key} = ${text};`,
    );

    return { attribute, key, value: text };
  }
}
