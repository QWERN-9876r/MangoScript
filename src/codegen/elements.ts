import type * as ast from '../ast.ts';
import { domProperty } from '../checker/dom.ts';
import type { Type } from '../checker/types.ts';
import { forEachChild } from '../walk.ts';
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

  protected override element(node: ast.ElementExpression): string {
    if (this.hoist) return this.build(node, null);
    const body = this.withHoisting(true, () =>
      this.block(() => this.line(`return ${this.build(node, null)};`)),
    );
    return `(() => ${body})()`;
  }

  protected override elementDeclaration(declaration: string, node: ast.ElementExpression): void {
    this.build(node, declaration);
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
      ? [{ kind: 'Parameter', name, type: null, start: value.start, end: value.start }]
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
        pending.push(this.build(child, null));
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
