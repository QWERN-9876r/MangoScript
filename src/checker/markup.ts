import type * as ast from '../ast.ts';
import { Scope } from './context.ts';
import { domProperty } from './dom.ts';
import { isContent, isAttributeValue, isUntyped } from './helpers.ts';
import { OperatorChecker } from './operators.ts';
import { BOOL, func, STRING, typeToString, type Type } from './types.ts';

// Markup: elements, their children and attributes, `bind:` and event handlers.

export abstract class MarkupChecker extends OperatorChecker {
  protected override checkElement(node: ast.ElementExpression): Type {
    if (node.tag && /^[A-Z]/.test(node.tag.name)) return this.checkComponentUse(node, node.tag);
    const tag = node.tag?.name ?? null;
    const type = tag === null ? this.dom.fragment : this.elementOf(tag);
    for (const attribute of node.attributes) {
      if (attribute.kind === 'JsxSpreadAttribute') {
        const spread = this.checkValue(attribute.argument);
        if (!isUntyped(spread) && spread.kind !== 'object') {
          this.error(`cannot spread ${typeToString(spread)} into attributes`, attribute.argument);
        }
      } else if (tag !== null && attribute.name.name.startsWith('bind:')) {
        this.checkBinding(attribute, tag, node.attributes);
      } else if (tag !== null) {
        this.checkAttribute(attribute, tag, type);
      }
    }
    for (const attribute of node.attributes) {
      if (attribute.kind !== 'JsxAttribute' || !attribute.name.name.startsWith('bind:')) continue;
      const property = attribute.name.name.slice('bind:'.length);
      const plain = node.attributes.some(
        (other) => other.kind === 'JsxAttribute' && other.name.name === property,
      );
      if (plain) {
        this.error(
          `"${property}" and "bind:${property}" set the same property: keep one of them`,
          attribute.name,
        );
      }
    }
    this.checkChildren(node.children);
    return type;
  }

  protected checkChildren(children: readonly ast.JsxChild[]): void {
    for (const child of children) {
      if (child.kind === 'JsxText') continue;
      if (child.kind === 'JsxStatementContainer') {
        // Checked like any if/for/switch, so conditions narrow types in the blocks.
        this.checkStatement(child.statement);
        continue;
      }
      if (child.kind === 'ElementExpression') {
        this.checkExpression(child, null);
        continue;
      }
      const content = this.checkValue(child.expression);
      if (!isContent(content, this.dom.node)) {
        this.error(
          `cannot use ${typeToString(content)} as element content` +
            (content.kind === 'bool' ? ': use a condition, e.g. {ok ? <b>yes</b> : null}' : ''),
          child.expression,
        );
      }
    }
  }

  protected checkAttribute(attribute: ast.JsxAttribute, tag: string, element: Type): void {
    const name = attribute.name.name;
    const { value } = attribute;
    // `<app-card count={3} />`: a property of a web component of this module.
    const webProperty = this.webComponentProperty(tag, name);
    if (webProperty) {
      this.checkProp(attribute, webProperty, tag);
      return;
    }
    if (/^on[A-Z]/.test(name)) {
      this.checkEventAttribute(attribute, this.eventOf(name, element));
      return;
    }
    if (value?.kind === 'EventHandler') return;
    const valueType =
      value === null ? BOOL : value.kind === 'StringLiteral' ? STRING : this.checkValue(value);

    if (name === 'style') {
      if (!isUntyped(valueType) && valueType.kind !== 'string' && valueType.kind !== 'object') {
        this.error(
          `style must be a string or an object, not ${typeToString(valueType)}`,
          attribute,
        );
      }
      return;
    }
    // `<a download>` without a value sets an empty attribute, whatever the property type is.
    if (value === null) return;
    const property = domProperty(tag, name);
    if (property) {
      this.expectAssignable(valueType, property.type, value, ` for attribute "${name}"`);
    } else if (!isAttributeValue(valueType)) {
      this.error(
        `attribute "${name}" needs a string, number or bool, not ${typeToString(valueType)}`,
        value,
      );
    }
  }

  /**
   * `bind:value={name}`: the element shows the variable, and what the user enters is written back
   * to it. So the value must be something that can be assigned.
   */
  protected checkBinding(
    attribute: ast.JsxAttribute,
    tag: string,
    attributes: readonly (ast.JsxAttribute | ast.JsxSpreadAttribute)[],
  ): void {
    const name = attribute.name.name;
    const property = name.slice('bind:'.length);
    const { value } = attribute;
    if (property !== 'value' && property !== 'checked') {
      this.error(`unknown binding "${name}": use bind:value or bind:checked`, attribute.name);
      return;
    }
    const tags = property === 'value' ? ['input', 'textarea', 'select'] : ['input'];
    if (!tags.includes(tag)) {
      this.error(
        property === 'value'
          ? 'bind:value works with <input>, <textarea> and <select>'
          : 'bind:checked works with <input>',
        attribute.name,
      );
    }
    if (value === null || value.kind === 'StringLiteral' || value.kind === 'EventHandler') {
      this.error(`"${name}" needs a variable in braces, e.g. ${name}={title}`, attribute);
      return;
    }
    const bindable =
      (value.kind === 'Identifier' && value.name !== '_') ||
      ((value.kind === 'MemberExpression' || value.kind === 'IndexExpression') && !value.optional);
    if (!bindable) {
      this.checkValue(value);
      this.error(`"${name}" needs a variable or a field to write to`, value);
      return;
    }
    const type = this.checkTarget(value);
    this.checkedTypes.set(value, type);
    if (isUntyped(type)) return;
    if (property === 'checked' && type.kind !== 'bool') {
      this.error(`bind:checked needs a bool, not ${typeToString(type)}`, value);
    } else if (property === 'value' && type.kind === 'number' && tag === 'input') {
      // A number is read with valueAsNumber, which only number and range inputs have.
      const typeAttribute = attributes.find(
        (other): other is ast.JsxAttribute =>
          other.kind === 'JsxAttribute' && other.name.name === 'type',
      )?.value;
      const inputType = typeAttribute?.kind === 'StringLiteral' ? typeAttribute.value : null;
      if (inputType !== 'number' && inputType !== 'range') {
        this.error(
          'a number can be bound to <input type="number"> or <input type="range">',
          attribute.name,
        );
      }
    } else if (
      property === 'value' &&
      type.kind !== 'string' &&
      !(type.kind === 'number' && tag === 'input')
    ) {
      const allowed = tag === 'input' ? 'a string or a number' : 'a string';
      this.error(`bind:value needs ${allowed}, not ${typeToString(type)}`, value);
    }
  }

  /** `onClick={...}`: code to run on the event, or a function that gets the event. */
  protected checkEventAttribute(attribute: ast.JsxAttribute, event: Type): void {
    const name = attribute.name.name;
    const { value } = attribute;
    if (value === null || value.kind === 'StringLiteral') {
      this.error(`"${name}" needs code or a function in braces, e.g. ${name}={save()}`, attribute);
    } else if (value.kind === 'EventHandler') {
      this.checkEventHandler(value, event);
    } else {
      const handler = func([event], []);
      const type = this.checkValue(value, handler);
      this.expectAssignable(type, handler, value, ` as the "${name}" handler`);
    }
  }

  /** The statements of `onClick={count++}`, with `event` declared when there is one. */
  protected checkEventHandler(handler: ast.EventHandler, event: Type | null): void {
    const saved = { scope: this.scope, flow: this.flow, fn: this.fn };
    this.scope = new Scope(this.scope);
    this.flow = this.stableFlow();
    this.fn = { results: [], returns: [], isConstructor: false };
    try {
      const name: ast.Identifier = {
        kind: 'Identifier',
        name: 'event',
        start: handler.start,
        end: handler.start,
      };
      if (event) this.declareValue(name, 'param', event);
      for (const statement of handler.body) this.checkStatement(statement);
    } finally {
      this.scope = saved.scope;
      this.flow = saved.flow;
      this.fn = saved.fn;
    }
  }
}
