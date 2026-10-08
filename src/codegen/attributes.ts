import type * as ast from '../ast.ts';
import { domProperty } from '../checker/dom.ts';
import { attributeName } from '../html-tag.ts';
import { eventName, mentions } from './element-helpers.ts';
import type { Live, Source } from './reactive.ts';
import { ARROW } from './syntax.ts';
import { UpdateEmitter } from './updates.ts';

// Attributes of elements: properties, setAttribute, styles, `bind:` and event handlers.

export abstract class AttributeEmitter extends UpdateEmitter {
  // Implemented by later layers: the checking of statements, expressions and markup calls each other.

  protected abstract liveExpression(node: ast.Expression, precedence?: number): string;

  protected abstract nextId(): number;

  protected abstract once(node: ast.Expression): string;

  /** Counter for `$$li1`, `$$div2`, ... */
  protected elementCount = 0;

  /** The element that elements of markup blocks are appended to, in plain control flow. */
  protected contentTarget: string | null = null;

  /** `onClick={count++}` becomes `() => { count++; }`; a function is used as it is. */
  protected handler(value: ast.JsxAttribute['value']): string {
    return this.withRendering(0, () => this.handlerFunction(value));
  }

  protected elementName(tag: string | null): string {
    const base = tag === null ? 'fragment' : /^[a-z][a-z0-9]*$/.test(tag) ? tag : 'element';
    return `$$${base}${this.nextId()}`;
  }

  protected attribute(
    element: string,
    tag: string | null,
    attribute: ast.JsxAttribute | ast.JsxSpreadAttribute,
    live: Live | null,
  ): void {
    if (attribute.kind === 'JsxSpreadAttribute') {
      this.setLive(live, attribute.argument, (text) => `Object.assign(${element}, ${text});`);
      return;
    }
    const name = attribute.name.name;
    const { value } = attribute;

    const webProperty = tag === null ? null : this.webComponentProperty(tag, name);
    if (webProperty) {
      this.webComponentAttribute(element, webProperty, value, live);
      return;
    }
    if (/^on[A-Z]/.test(name)) {
      this.inHandler++;
      try {
        this.line(
          `${element}.addEventListener(${JSON.stringify(eventName(name))}, ${this.handler(value)});`,
        );
      } finally {
        this.inHandler--;
      }
      return;
    }
    if (value?.kind === 'EventHandler') return;

    if (name === 'style' && value !== null) {
      const isString = value.kind === 'StringLiteral' || this.typeOf(value)?.kind === 'string';
      this.setLive(live, value, (text) =>
        isString
          ? `${element}.style.cssText = ${text};`
          : `Object.assign(${element}.style, ${text});`,
      );
      return;
    }

    const property = tag === null ? null : domProperty(tag, name);
    if (value === null) {
      // `<input disabled>`: true for boolean properties, an empty attribute otherwise.
      this.line(
        property?.type.kind === 'bool'
          ? `${element}.${property.name} = true;`
          : `${element}.setAttribute(${JSON.stringify(name)}, "");`,
      );
      return;
    }
    if (property) {
      this.setLive(live, value, (text) => `${element}.${property.name} = ${text};`);
      return;
    }
    const quoted = JSON.stringify(name);
    if (this.typeOf(value)?.kind !== 'nullable') {
      this.setLive(live, value, (text) => `${element}.setAttribute(${quoted}, ${text});`);
    } else if (live && live.dependencies(value).size > 0) {
      this.helpers.add('attribute');
      this.setLive(live, value, (text) => `$$attribute(${element}, ${quoted}, ${text});`);
    } else {
      // A null value leaves the attribute out.
      const text = this.once(value);
      this.line(`if (${text} != null) ${element}.setAttribute(${quoted}, ${text});`);
    }
  }

  /** `<app-card item-count={1} />`: the property of a web component of this module, if it has one. */
  protected webComponentProperty(tag: string, name: string): ast.Parameter | null {
    const component = this.webComponents.get(tag);
    if (!component) return null;
    const param = component.params.find(
      (param) =>
        param.name.name !== 'children' &&
        (param.name.name === name || attributeName(param.name.name) === name),
    );
    return param ?? null;
  }

  /** A property of a web component is set as a JS property, so it may be an object or a function. */
  protected webComponentAttribute(
    element: string,
    param: ast.Parameter,
    value: ast.JsxAttribute['value'],
    live: Live | null,
  ): void {
    const target = `${element}.${param.name.name}`;
    if (value === null) {
      this.line(`${target} = true;`);
    } else if (
      value.kind === 'EventHandler' ||
      value.kind === 'ArrowFunction' ||
      value.kind === 'FuncExpression'
    ) {
      this.inHandler++;
      try {
        this.line(`${target} = ${this.handler(value)};`);
      } finally {
        this.inHandler--;
      }
    } else {
      this.setLive(live, value, (text) => `${target} = ${text};`);
    }
  }

  /**
   * Writes the statement that sets a value. In live markup, when the value depends on state, the
   * same statement also goes into the updates of that state.
   */
  protected setLive(
    live: Live | null,
    value: ast.Expression,
    statement: (text: string) => string,
  ): void {
    const sources = live && value.kind !== 'StringLiteral' ? live.dependencies(value) : null;
    if (!live || !sources || sources.size === 0) {
      this.line(statement(this.expression(value, ARROW)));
      return;
    }
    const text = statement(this.liveExpression(value));
    this.line(text);
    live.depend(sources, text);
  }

  /**
   * `bind:value={name}`: the element shows the variable, and what the user enters is written
   * back to it. In live markup the element is also updated when the variable changes elsewhere.
   */
  protected binding(
    element: string,
    tag: string,
    attribute: ast.JsxAttribute,
    live: Live | null,
  ): void {
    const value = attribute.value as ast.Expression;
    const isNumber = attribute.name.name === 'bind:value' && this.typeOf(value)?.kind === 'number';
    const property =
      attribute.name.name === 'bind:checked' ? 'checked' : isNumber ? 'valueAsNumber' : 'value';
    const target = this.liveExpression(value);
    const current = `${element}.${property}`;
    this.line(`${current} = ${target};`);

    const event = property === 'checked' || tag === 'select' ? 'change' : 'input';
    const written = [...(this.reactive?.rootSources(value) ?? [])].filter(
      (source) => source.kind === 'state',
    );
    const dependsOn = live?.dependencies(value) ?? new Set<Source>();
    this.inHandler++;
    try {
      const body = this.block(() => {
        this.line(`${target} = ${current};`);
        for (const source of written) {
          // The element already shows what was entered: its own update is skipped.
          const own = live && dependsOn.has(source) ? live.ownIndex(source) : null;
          this.line(`${this.write(source, own)};`);
        }
      });
      this.line(`${element}.addEventListener(${JSON.stringify(event)}, () => ${body});`);
    } finally {
      this.inHandler--;
    }

    // NaN from an unfinished number must not clear the input while the user types.
    const differs = isNumber ? `!Object.is(${current}, ${target})` : `${current} !== ${target}`;
    if (live && dependsOn.size > 0) {
      live.depend(dependsOn, `if (${differs}) ${current} = ${target};`);
    }
  }

  protected handlerFunction(value: ast.JsxAttribute['value']): string {
    if (value === null) return '() => {}';
    if (value.kind !== 'EventHandler') return this.expression(value, ARROW);
    const name: ast.Identifier = {
      kind: 'Identifier',
      name: 'event',
      start: value.start,
      end: value.start,
    };
    const params: ast.Parameter[] = mentions(value, 'event')
      ? [
          {
            kind: 'Parameter',
            name,
            type: null,
            defaultValue: null,
            start: value.start,
            end: value.start,
          },
        ]
      : [];
    return this.withFunction('none', params, () => {
      const body = this.block(() => this.statements(value.body));
      return `(${params.length > 0 ? 'event' : ''}) => ${body}`;
    });
  }
}
