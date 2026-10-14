import type * as ast from '../ast.ts';
import { ComponentChecker } from './components.ts';
import type { ComponentInfo } from './context.ts';
import { isUntyped } from './helpers.ts';

const upperFirst = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

import {
  isNullable,
  typeToString,
  UNKNOWN,
  type ComponentParam,
  type ComponentType,
  type Type,
} from './types.ts';

// Components as values: `content: Intro` has the type `comp()`, and a tag takes the component
// from a value, `<section.content />`, or `<Page />` when `Page` is a variable. Such a tag passes
// the properties by their positions in the type, so the component is a function in its module.

export abstract class ComponentValueChecker extends ComponentChecker {
  /** `Card` as a value: `comp(title string, kind ?Kind)`, without `...attrs`. */
  protected override componentValue(info: ComponentInfo): ComponentType {
    const params: ComponentParam[] = info.node.params.flatMap((param) => {
      const prop = info.props.get(param.name.name);

      return param.rest || !prop ? [] : [{ name: param.name.name, ...prop }];
    });

    return { kind: 'component', params };
  }

  /** `<section.content title="Hi" />`: the attributes are checked against the type of the value. */
  protected override checkValueTagUse(
    node: ast.ElementExpression,
    tag: ast.Identifier,
    value: ast.Expression,
  ): Type {
    const type = this.checkValue(value);
    const name = tag.name;

    if (isUntyped(type) || type.kind !== 'component') {
      if (isNullable(type)) {
        // Only variables are narrowed, so a path goes into one first.
        const variable = /^[A-Z]/.test(name) ? name : upperFirst(name.split('.').at(-1)!);
        const show = `{if ${variable} != null { <${variable} /> }}`;

        this.error(
          name === variable
            ? `<${name}> may be null: show it with {if}, e.g. ${show}`
            : `<${name}> may be null: put it into a variable and show it with {if}, e.g. const ${variable} = ${name}, then ${show}`,
          tag,
        );
      } else if (!isUntyped(type)) {
        this.error(
          `<${name}> is ${typeToString(type)}, not a component: give it a type like comp(title string)`,
          tag,
        );
      } else if (type.kind === 'any' && (node.attributes.length > 0 || node.children.length > 0)) {
        // The tag passes the properties by position, which only the type knows.
        this.error(
          `<${name}> is any, so the order of its properties is not known: give it a type like comp(title string)`,
          tag,
        );
      }

      this.checkValueTagAttributes(node, null);

      return this.dom.node;
    }

    this.checkValueTagAttributes(node, type);

    return this.dom.node;
  }

  private checkValueTagAttributes(node: ast.ElementExpression, type: ComponentType | null): void {
    const name = node.tag!.name;
    const given = new Set<string>();

    for (const attribute of node.attributes) {
      if (attribute.kind === 'JsxSpreadAttribute') {
        this.checkValue(attribute.argument);
        // After the error, missing properties would only repeat it.
        for (const param of type?.params ?? []) given.add(param.name);
        this.error(
          `<${name}> takes its component from a value, so its properties are passed one by one, not spread`,
          attribute,
        );
        continue;
      }

      const attributeName = attribute.name.name;
      const param = type?.params.find((each) => each.name === attributeName);

      if (attributeName === 'ref') {
        this.error(
          `ref cannot point to <${name}>: its component is a value, so its element is not known in advance`,
          attribute,
        );
        continue;
      }

      if (given.has(attributeName)) {
        this.error(`duplicate property "${attributeName}"`, attribute.name);
      }

      given.add(attributeName);
      if (attributeName === 'children' && param) {
        this.error(`pass children between the tags: <${name}>...</${name}>`, attribute.name);
      } else if (param) {
        this.checkProp(attribute, param.type, name);
      } else if (type) {
        this.error(`<${name}> has no property "${attributeName}"`, attribute.name);
      } else {
        this.checkProp(attribute, UNKNOWN, name);
      }
    }

    for (const param of type?.params ?? []) {
      if (!param.optional && !given.has(param.name)) {
        this.error(`<${name}> needs the property "${param.name}"`, node.tag!);
      }
    }

    if (type && node.children.length > 0 && !type.params.some((each) => each.name === 'children')) {
      this.error(`<${name}> takes no children`, node.children[0]!);
    }

    this.checkChildren(node.children);
  }
}
