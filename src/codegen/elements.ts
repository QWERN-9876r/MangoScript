import type * as ast from '../ast.ts';
import { domProperty } from '../checker/dom.ts';
import type { Type } from '../checker/types.ts';
import { forEachChild } from '../walk.ts';
import { namesDeclaredIn } from './analysis.ts';
import { StatementEmitter } from './statements.ts';
import { ARROW } from './syntax.ts';

/**
 * Markup: `<a href="/">Ссылка {name}</a>` becomes statements that create the element. When the
 * expression is evaluated exactly once they go before the statement that contains it; otherwise
 * the element is created inside a function that is called right away.
 */
export abstract class ElementEmitter extends StatementEmitter {
  /** Counter for `$$li1`, `$$div2`, ... */
  private elementCount = 0;
  private readonly componentNames = new Map<ast.ComponentDeclaration, Set<string>>();

  protected override element(node: ast.ElementExpression): string {
    if (this.hoist) return this.create(node);
    const body = this.withHoisting(true, () =>
      this.block(() => this.line(`return ${this.create(node)};`)),
    );
    return `(() => ${body})()`;
  }

  protected override elementDeclaration(declaration: string, node: ast.ElementExpression): void {
    const component = this.componentOf(node);
    if (component) this.line(`${declaration} = ${this.expand(node, component)};`);
    else this.build(node, declaration);
  }

  /** Writes the code for an element or a component and returns the variable with the result. */
  private create(node: ast.ElementExpression): string {
    const component = this.componentOf(node);
    return component ? this.expand(node, component) : this.build(node, null);
  }

  private componentOf(node: ast.ElementExpression): ast.ComponentDeclaration | undefined {
    return node.tag ? this.components.get(node.tag.name) : undefined;
  }

  /**
   * Inlines a component: its code goes into a block where its properties are constants. Attribute
   * values are computed before the block, so that the component's own names cannot hide the
   * names they refer to.
   */
  private expand(node: ast.ElementExpression, component: ast.ComponentDeclaration): string {
    const name = component.name.name;
    this.line(`// <${name}>`);
    const values = new Map<string, string>();
    for (const attribute of node.attributes) {
      if (attribute.kind === 'JsxAttribute') {
        values.set(attribute.name.name, this.prop(attribute, component));
      }
    }
    if (component.params.some((param) => param.name.name === 'children')) {
      const fragment = `$$children${++this.elementCount}`;
      this.line(`const ${fragment} = document.createDocumentFragment();`);
      this.children(fragment, node.children);
      values.set('children', fragment);
    }

    const result = `$$${name.charAt(0).toLowerCase()}${name.slice(1)}${++this.elementCount}`;
    this.line(`let ${result};`);
    const props = component.params.map((param): [string, 'const'] => [param.name.name, 'const']);
    const block = this.block(() =>
      this.withScope(props, () => {
        for (const param of component.params) {
          const value =
            values.get(param.name.name) ??
            (param.defaultValue ? this.expression(param.defaultValue, ARROW) : 'null');
          this.line(`const ${this.name(param.name.name)} = ${value};`);
        }
        const body = component.body.body;
        const last = body.at(-1);
        this.blockStatements(last?.kind === 'ReturnStatement' ? body.slice(0, -1) : body, () => {
          const value = last?.kind === 'ReturnStatement' ? last.values[0] : undefined;
          if (!value) return;
          this.withHoisting(true, () => {
            if (value.kind === 'ElementExpression' && !this.componentOf(value)) {
              this.build(value, result);
            } else {
              this.line(`${result} = ${this.expression(value, ARROW)};`);
            }
          });
        });
      }),
    );
    this.line(block);
    return result;
  }

  /**
   * The value of a component property. Literals and names that the component does not redeclare
   * go into its code as they are; anything else is computed before the block into a temporary.
   */
  private prop(attribute: ast.JsxAttribute, component: ast.ComponentDeclaration): string {
    const { value } = attribute;
    if (value === null) return 'true';
    if (value.kind !== 'EventHandler') {
      let declared = this.componentNames.get(component);
      if (!declared) {
        declared = namesDeclaredIn(component);
        this.componentNames.set(component, declared);
      }
      const root = rootName(value);
      if (isConstant(value) || (isSimple(value) && root !== null && !declared.has(root))) {
        return this.expression(value, ARROW);
      }
    }
    const text =
      value.kind === 'EventHandler' ? this.handler(value) : this.expression(value, ARROW);
    const temp = this.temp();
    this.line(`const ${temp} = ${text};`);
    return temp;
  }

  /**
   * Writes the statements that create the element and returns the name of its variable.
   * `declaration` is `const link` for `const link = <a>`; otherwise a temporary name is used.
   */
  private build(node: ast.ElementExpression, declaration: string | null): string {
    const tag = node.tag?.name ?? null;
    const name = declaration?.split(' ').at(-1) ?? this.elementName(tag);
    const create =
      tag === null
        ? 'document.createDocumentFragment()'
        : `document.createElement(${JSON.stringify(tag)})`;
    this.line(`${declaration ?? `const ${name}`} = ${create};`);
    for (const attribute of node.attributes) this.attribute(name, tag, attribute);
    this.children(name, node.children);
    return name;
  }

  private elementName(tag: string | null): string {
    const base = tag === null ? 'fragment' : /^[a-z][a-z0-9]*$/.test(tag) ? tag : 'element';
    return `$$${base}${++this.elementCount}`;
  }

  private attribute(
    element: string,
    tag: string | null,
    attribute: ast.JsxAttribute | ast.JsxSpreadAttribute,
  ): void {
    if (attribute.kind === 'JsxSpreadAttribute') {
      this.line(`Object.assign(${element}, ${this.expression(attribute.argument, ARROW)});`);
      return;
    }
    const name = attribute.name.name;
    const { value } = attribute;

    if (/^on[A-Z]/.test(name)) {
      this.line(
        `${element}.addEventListener(${JSON.stringify(eventName(name))}, ${this.handler(value)});`,
      );
      return;
    }
    if (value?.kind === 'EventHandler') return;

    if (name === 'style' && value !== null) {
      const text = this.expression(value, ARROW);
      const isString = value.kind === 'StringLiteral' || this.typeOf(value)?.kind === 'string';
      this.line(
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
      this.line(`${element}.${property.name} = ${this.expression(value, ARROW)};`);
      return;
    }
    const setAttribute = (text: string) =>
      `${element}.setAttribute(${JSON.stringify(name)}, ${text});`;
    if (this.typeOf(value)?.kind === 'nullable') {
      // A null value leaves the attribute out.
      const text = this.once(value);
      this.line(`if (${text} != null) ${setAttribute(text)}`);
    } else {
      this.line(setAttribute(this.expression(value, ARROW)));
    }
  }

  /** `onClick={count++}` becomes `() => { count++; }`; a function is used as it is. */
  private handler(value: ast.JsxAttribute['value']): string {
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

  /**
   * Children are appended in order; consecutive ones that need no checks go into one `append`.
   * Values whose type allows null, or is not known, are checked before they are appended.
   */
  private children(element: string, children: readonly ast.JsxChild[]): void {
    let pending: string[] = [];
    let pendingCalls = false;
    const flush = () => {
      if (pending.length > 0) this.line(`${element}.append(${pending.join(', ')});`);
      pending = [];
      pendingCalls = false;
    };

    for (const child of children) {
      if (child.kind === 'JsxText') {
        pending.push(JSON.stringify(child.value));
        continue;
      }
      if (child.kind === 'ElementExpression') {
        // A child element is created before the append; earlier calls must still run first.
        if (pendingCalls) flush();
        pending.push(this.create(child));
        continue;
      }
      const { expression } = child;
      switch (contentKind(expression, this.typeOf(expression))) {
        case 'value':
          pending.push(this.expression(expression, ARROW));
          pendingCalls ||= !isSimple(expression);
          break;
        case 'list':
          pending.push(`...${this.expression(expression, ARROW)}`);
          pendingCalls ||= !isSimple(expression);
          break;
        case 'nullable': {
          flush();
          const text = this.once(expression);
          this.line(`if (${text} != null) ${element}.append(${text});`);
          break;
        }
        case 'unknown':
          flush();
          this.helpers.add('append');
          this.line(`$$append(${element}, ${this.expression(expression, ARROW)});`);
          break;
      }
    }
    flush();
  }

  /** The expression if it can be repeated, otherwise a temporary that holds its value. */
  private once(node: ast.Expression): string {
    if (isSimple(node)) return this.expression(node, ARROW);
    const temp = this.temp();
    this.line(`const ${temp} = ${this.expression(node, ARROW)};`);
    return temp;
  }

  private typeOf(node: ast.Expression): Type | undefined {
    return this.options.types?.get(node);
  }
}

/** `onClick` → `click`, `onKeyDown` → `keydown`; JSX spells `dblclick` as `onDoubleClick`. */
function eventName(attribute: string): string {
  return attribute === 'onDoubleClick' ? 'dblclick' : attribute.slice(2).toLowerCase();
}

/** How a child expression is appended: as is, spread, after a null check, or by $$append. */
function contentKind(
  node: ast.Expression,
  type: Type | undefined,
): 'value' | 'list' | 'nullable' | 'unknown' {
  if (type === undefined) {
    // Without types only literals are known for sure.
    return node.kind === 'StringLiteral' ||
      node.kind === 'NumberLiteral' ||
      node.kind === 'TemplateLiteral'
      ? 'value'
      : 'unknown';
  }
  switch (type.kind) {
    case 'string':
    case 'number':
    case 'object':
    case 'class':
      return 'value';
    case 'array':
      return isPlainContent(type.element) ? 'list' : 'unknown';
    case 'nullable':
      return isPlainContent(type.type) ? 'nullable' : 'unknown';
    default:
      return 'unknown';
  }
}

function isPlainContent(type: Type): boolean {
  return (
    type.kind === 'string' ||
    type.kind === 'number' ||
    type.kind === 'object' ||
    type.kind === 'class'
  );
}

/** The variable at the start of `a.b.c`, or `null`. */
function rootName(node: ast.Expression): string | null {
  if (node.kind === 'Identifier') return node.name;
  return node.kind === 'MemberExpression' ? rootName(node.object) : null;
}

/** Literals, which can be put into the component's code as they are. */
function isConstant(node: ast.Expression): boolean {
  switch (node.kind) {
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
      return true;
    case 'TemplateLiteral':
      return node.expressions.length === 0;
    case 'UnaryExpression':
      return node.operator === '-' && node.argument.kind === 'NumberLiteral';
    default:
      return false;
  }
}

/** Expressions without side effects, which may be evaluated more than once. */
function isSimple(node: ast.Expression): boolean {
  switch (node.kind) {
    case 'Identifier':
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'ThisExpression':
      return true;
    case 'MemberExpression':
      return isSimple(node.object);
    default:
      return false;
  }
}

/** Whether a name is used inside a node, e.g. `event` in a handler. */
function mentions(node: ast.Node, name: string): boolean {
  let found = false;
  const visit = (child: ast.Node): void => {
    if (found) return;
    if (child.kind === 'Identifier' && child.name === name) found = true;
    else if (child.kind === 'MemberExpression') visit(child.object);
    else forEachChild(child, visit);
  };
  visit(node);
  return found;
}
