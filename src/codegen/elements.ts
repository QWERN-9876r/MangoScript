import type * as ast from '../ast.ts';
import { isSimple, startsWithObjectLiteral } from './analysis.ts';
import { AttributeEmitter } from './attributes.ts';
import { contentKind, type Content, type ControlStatement } from './element-helpers.ts';
import type { Live, Source } from './reactive.ts';
import { ARROW, arrayPattern } from './syntax.ts';

export type { ControlStatement } from './element-helpers.ts';

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

export abstract class ElementEmitter extends AttributeEmitter {
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
  protected override nextId(): number {
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
  protected override liveExpression(node: ast.Expression, precedence = ARROW): string {
    return this.withRendering(this.rendering + 1, () =>
      this.withHoisting(false, () => this.expression(node, precedence)),
    );
  }

  /**
   * `{value}` that depends on state. Text becomes a text node whose data is replaced; other
   * content is kept by the $$content helper, which replaces its nodes. Returns what to append.
   */
  protected liveChild(
    expression: ast.Expression,
    live: Live,
    sources: ReadonlySet<Source>,
  ): string {
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
  protected blockConst(node: ast.VariableDeclaration, live: Live | null): void {
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
  protected override once(node: ast.Expression): string {
    if (isSimple(node)) return this.expression(node, ARROW);
    const temp = this.temp();
    this.line(`const ${temp} = ${this.expression(node, ARROW)};`);
    return temp;
  }
}
