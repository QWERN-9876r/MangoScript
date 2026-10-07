import type * as ast from '../ast.ts';
import { domProperty } from '../checker/dom.ts';
import type { Type } from '../checker/types.ts';
import { forEachChild } from '../walk.ts';
import { isSimple, startsWithObjectLiteral } from './analysis.ts';
import type { Live, Source } from './reactive.ts';
import { ARROW, arrayPattern } from './syntax.ts';
import { UpdateEmitter } from './updates.ts';

/** What can be inside markup: children of an element, or statements of a markup block. */
type Content = ast.JsxChild | ast.Statement;

export type ControlStatement = ast.JsxStatementContainer['statement'];

/**
 * Markup: `<a href="/">Link {name}</a>` becomes statements that create the element. When the
 * expression is evaluated exactly once they go before the statement that contains it; otherwise
 * the element is created inside a function that is called right away.
 *
 * Markup that a component creates once (what it returns, and elements declared at the top level
 * of its body) is live: parts that read state are updated when the state changes. `live` is where
 * their updates go. `{if ...}`, `{switch ...}` and `{for ...}` become plain JS control flow that
 * appends elements, unless they depend on state; see ControlFlowEmitter.
 */
export abstract class ElementEmitter extends UpdateEmitter {
  /** Counter for `$$li1`, `$$div2`, ... */
  private elementCount = 0;
  /** The element that elements of markup blocks are appended to, in plain control flow. */
  private contentTarget: string | null = null;

  /** Inlines a component; implemented by ComponentEmitter. */
  protected abstract expand(
    node: ast.ElementExpression,
    component: ast.ComponentDeclaration,
    live: Live | null,
  ): string;

  /** Control flow in live markup that depends on state; implemented by ControlFlowEmitter. */
  protected abstract liveControl(
    statement: ControlStatement,
    live: Live,
    sources: ReadonlySet<Source>,
  ): string;

  protected override element(node: ast.ElementExpression): string {
    if (this.hoist) return this.create(node, null);
    const body = this.withHoisting(true, () =>
      this.block(() => this.line(`return ${this.create(node, null)};`)),
    );
    return `(() => ${body})()`;
  }

  protected override elementDeclaration(declaration: string, node: ast.ElementExpression): void {
    const live = this.reactive?.topLevel.has(node) ? this.reactive : null;
    const component = this.componentOf(node);
    if (component) this.line(`${declaration} = ${this.expand(node, component, live)};`);
    else this.build(node, declaration, live);
  }

  protected override elementStatement(node: ast.JsxElementStatement): void {
    if (this.contentTarget === null) throw new Error('an element statement outside of markup');
    const element = this.create(node.element, null);
    this.line(`${this.contentTarget}.append(${element});`);
  }

  /** A number for a generated name: `$$li1`, `$$updateCount2`, ... */
  protected nextId(): number {
    return ++this.elementCount;
  }

  /** Writes the code for an element or a component and returns the variable with the result. */
  protected create(node: ast.ElementExpression, live: Live | null): string {
    const component = this.componentOf(node);
    return component ? this.expand(node, component, live) : this.build(node, null, live);
  }

  protected componentOf(node: ast.ElementExpression): ast.ComponentDeclaration | undefined {
    return node.tag ? this.components.get(node.tag.name) : undefined;
  }

  /**
   * Writes the statements that create the element and returns the name of its variable.
   * `declaration` is `const link` for `const link = <a>`; otherwise a temporary name is used.
   */
  protected build(
    node: ast.ElementExpression,
    declaration: string | null,
    live: Live | null,
  ): string {
    const tag = node.tag?.name ?? null;
    const name = declaration?.split(' ').at(-1) ?? this.elementName(tag);
    const create =
      tag === null
        ? 'document.createDocumentFragment()'
        : `document.createElement(${JSON.stringify(tag)})`;
    this.line(`${declaration ?? `const ${name}`} = ${create};`);
    // Bindings go last: `valueAsNumber` needs the `type` attribute to be set.
    const bindings: ast.JsxAttribute[] = [];
    for (const attribute of node.attributes) {
      if (attribute.kind === 'JsxAttribute' && attribute.name.name.startsWith('bind:')) {
        bindings.push(attribute);
      } else {
        this.attribute(name, tag, attribute, live);
      }
    }
    if (tag !== null) {
      for (const attribute of bindings) this.binding(name, tag, attribute, live);
    }
    this.children(name, node.children, live);
    return name;
  }

  /** `onClick={count++}` becomes `() => { count++; }`; a function is used as it is. */
  protected handler(value: ast.JsxAttribute['value']): string {
    return this.withRendering(0, () => this.handlerFunction(value));
  }

  /**
   * Children are appended in order; consecutive ones that need no checks go into one `append`.
   * Values whose type allows null, or is not known, are checked before they are appended. The
   * statements of markup blocks are handled here too.
   */
  protected children(element: string, children: readonly Content[], live: Live | null): void {
    let pending: string[] = [];
    let pendingCalls = false;
    const flush = () => {
      if (pending.length > 0) this.line(`${element}.append(${pending.join(', ')});`);
      pending = [];
      pendingCalls = false;
    };

    for (const child of children) {
      switch (child.kind) {
        case 'JsxText':
          pending.push(JSON.stringify(child.value));
          break;
        case 'ElementExpression':
        case 'JsxElementStatement': {
          // A child element is created before the append; earlier calls must still run first.
          if (pendingCalls) flush();
          const node = child.kind === 'ElementExpression' ? child : child.element;
          pending.push(this.create(node, live));
          break;
        }
        case 'JsxStatementContainer':
        case 'IfStatement':
        case 'ForStatement':
        case 'ForInStatement':
        case 'SwitchStatement': {
          const statement = child.kind === 'JsxStatementContainer' ? child.statement : child;
          const sources = live?.dependencies(statement);
          if (live && sources && sources.size > 0) {
            if (pendingCalls) flush();
            pending.push(this.liveControl(statement, live, sources));
          } else {
            // Nothing in it changes: plain control flow that appends the elements.
            flush();
            this.withContentTarget(element, () => this.statement(statement));
          }
          break;
        }
        case 'VariableDeclaration':
          flush();
          this.blockConst(child, live);
          break;
        case 'JsxExpressionContainer': {
          const { expression } = child;
          const sources = live?.dependencies(expression);
          if (live && sources && sources.size > 0) {
            if (pendingCalls) flush();
            pending.push(this.liveChild(expression, live, sources));
            break;
          }
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
          break;
        }
        default:
          // The parser allows no other statements in markup.
          flush();
          this.statement(child);
      }
    }
    flush();
  }

  protected withContentTarget<T>(element: string, emit: () => T): T {
    const saved = this.contentTarget;
    this.contentTarget = element;
    try {
      return emit();
    } finally {
      this.contentTarget = saved;
    }
  }

  /** `() => value`, evaluated by a helper when the markup is created and on updates. */
  protected liveFunction(node: ast.Expression): string {
    const text = this.liveExpression(node);
    return `() => ${startsWithObjectLiteral(node) ? `(${text})` : text}`;
  }

  /**
   * An expression that is evaluated again on updates: elements inside it are created in place,
   * so that each evaluation creates new ones.
   */
  protected liveExpression(node: ast.Expression, precedence = ARROW): string {
    return this.withRendering(this.rendering + 1, () =>
      this.withHoisting(false, () => this.expression(node, precedence)),
    );
  }

  private elementName(tag: string | null): string {
    const base = tag === null ? 'fragment' : /^[a-z][a-z0-9]*$/.test(tag) ? tag : 'element';
    return `$$${base}${this.nextId()}`;
  }

  private attribute(
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

  /**
   * Writes the statement that sets a value. In live markup, when the value depends on state, the
   * same statement also goes into the updates of that state.
   */
  private setLive(
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
  private binding(
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

  private handlerFunction(value: ast.JsxAttribute['value']): string {
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
   * `{value}` that depends on state. Text becomes a text node whose data is replaced; other
   * content is kept by the $$content helper, which replaces its nodes. Returns what to append.
   */
  private liveChild(expression: ast.Expression, live: Live, sources: ReadonlySet<Source>): string {
    const kind = this.typeOf(expression)?.kind;
    const id = this.nextId();
    if (kind === 'string' || kind === 'number') {
      const text = this.liveExpression(expression);
      const node = `$$text${id}`;
      this.line(`const ${node} = document.createTextNode(${text});`);
      live.depend(sources, `${node}.data = ${text};`);
      return node;
    }
    const name = `$$content${id}`;
    const update = `$$updateContent${id}`;
    this.helpers.add('content');
    this.line(`const [${name}, ${update}] = $$content(${this.liveFunction(expression)});`);
    live.depend(sources, `${update}();`);
    return name;
  }

  /**
   * `const` in a markup block. When its value depends on state, it is computed again on updates,
   * before the parts that read it.
   */
  private blockConst(node: ast.VariableDeclaration, live: Live | null): void {
    const sources = live?.dependencies(node);
    const names = node.names.map((name) => (name.name === '_' ? '' : this.name(name.name)));
    if (!live || !sources || sources.size === 0 || names.every((name) => name === '')) {
      this.statement(node);
      return;
    }
    const values = node.values.map((value) => this.liveExpression(value));
    const assignments =
      values.length === names.length
        ? names.flatMap((name, i) => (name === '' ? [] : [`${name} = ${values[i]}`]))
        : [`${arrayPattern(names)} = ${values[0]}`];
    this.line(`let ${assignments.join(', ')};`);
    for (const assignment of assignments) live.depend(sources, `${assignment};`);
  }

  /** The expression if it can be repeated, otherwise a temporary that holds its value. */
  private once(node: ast.Expression): string {
    if (isSimple(node)) return this.expression(node, ARROW);
    const temp = this.temp();
    this.line(`const ${temp} = ${this.expression(node, ARROW)};`);
    return temp;
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
