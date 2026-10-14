import type * as ast from '../ast.ts';
import { widenLiterals } from '../checker/types.ts';
import { constantAttributes } from '../refs.ts';
import { hasClass } from '../styles.ts';
import { childrenInSvg, isSvgElement } from '../svg.ts';
import { isSimple } from './analysis.ts';
import { CreationEmitter } from './creation.ts';
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

export abstract class ElementEmitter extends CreationEmitter {
  /** A tag that takes its component from a value; implemented by ComponentValueEmitter. */
  protected abstract valueTag(
    node: ast.ElementExpression,
    value: ast.Expression,
    live: Live | null,
  ): string;

  /** Inlines a component; implemented by ComponentEmitter. */
  protected abstract expand(
    node: ast.ElementExpression,
    component: ast.ComponentDeclaration,
    live: Live | null,
  ): string;

  /**
   * The element a ref created for markup to fill in; not `created` when it may be missing, as
   * `$$root` of a function. Implemented by RefEmitter.
   */
  protected abstract presetElement(
    node: ast.ElementExpression,
  ): { name: string; created: boolean } | null;

  /** The class of the style an element belongs to; implemented by StyleEmitter. */
  protected abstract scopeOf(node: ast.ElementExpression): string | null;

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
    const live = this.declaredLive(node);
    const component = this.componentOf(node);
    const value = this.tagValue(node);

    if (component) this.line(`${declaration} = ${this.expand(node, component, live)};`);
    else if (value) this.line(`${declaration} = ${this.valueTag(node, value, live)};`);
    else this.build(node, declaration, live);
  }

  /** Where the updates of `const x = <markup>` go: markup at the top level of a component is live. */
  protected declaredLive(node: ast.ElementExpression): Live | null {
    return this.reactive?.topLevel.has(node) ? this.reactive : null;
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
    const value = this.tagValue(node);

    if (component) return this.expand(node, component, live);

    return value ? this.valueTag(node, value, live) : this.build(node, null, live);
  }

  protected componentOf(node: ast.ElementExpression): ast.ComponentDeclaration | undefined {
    return node.tag && node.value === null ? this.componentNamed(node.tag.name) : undefined;
  }

  /** `section.content` of `<section.content />`, or `Page` of `<Page />` with a variable `Page`. */
  protected tagValue(node: ast.ElementExpression): ast.Expression | null {
    if (node.value || !node.tag || !/^[A-Z]/.test(node.tag.name)) return node.value;

    return this.componentNamed(node.tag.name) ? null : node.tag;
  }

  /** Markup that creates an element or a fragment, not a component. */
  protected isElement(node: ast.ElementExpression): boolean {
    return !this.componentOf(node) && !this.tagValue(node);
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
    const svg = tag !== null && isSvgElement(tag, this.inSvg);
    const preset = this.presetElement(node);
    // A ref created the element with its constant attributes, so the markup only fills it in.
    const created = preset?.created ? preset.name : null;
    const name = created ?? declaration?.split(' ').at(-1) ?? this.elementName(tag);
    // Set by a ref, or by the helper that creates the element.
    const covered = new Set<ast.JsxAttribute | ast.JsxSpreadAttribute>(
      created ? constantAttributes(node) : [],
    );
    const scope = tag === null ? null : this.scopeOf(node);
    // A spread may set the class: the class of the style is added after it, so that both stay.
    const spread = node.attributes.some((attribute) => attribute.kind === 'JsxSpreadAttribute');
    const scopeClass = scope && !created && !hasClass(node) ? scope : null;
    let scoped = false;

    if (created === null) {
      const target = declaration ?? `const ${name}`;

      if (tag === null) {
        this.line(`${target} = document.createDocumentFragment();`);
      } else if (preset) {
        this.createdElements++;
        this.line(`${target} = ${preset.name} ?? ${this.createElement(tag, svg)};`);
      } else {
        const creation = this.createWith(
          target,
          name,
          tag,
          svg,
          node.attributes,
          live,
          scope,
          spread ? null : scopeClass,
        );

        for (const attribute of creation.covered) covered.add(attribute);
        scoped = creation.scoped;
      }
    }

    // Bindings go last: `valueAsNumber` needs the `type` attribute to be set.
    const bindings: ast.JsxAttribute[] = [];

    for (const attribute of node.attributes) {
      if (covered.has(attribute)) continue;
      if (attribute.kind === 'JsxAttribute' && attribute.name.name === 'ref') continue;
      if (attribute.kind === 'JsxAttribute' && attribute.name.name.startsWith('bind:')) {
        bindings.push(attribute);
      } else {
        this.attribute(name, tag, attribute, live, svg, scope);
      }
    }

    // Without a class attribute the element still gets the class of its style; a ref has set it.
    if (scopeClass !== null && !scoped) {
      if (spread) this.line(`${name}.classList.add(${JSON.stringify(scopeClass)});`);
      else this.scopeClass(name, scopeClass, svg);
    }

    if (tag !== null) {
      for (const attribute of bindings) this.binding(name, tag, attribute, live);
    }

    const inSvg = this.inSvg;

    this.inSvg = childrenInSvg(tag, svg, inSvg);
    try {
      this.children(name, node.children, live);
    } finally {
      this.inSvg = inSvg;
    }

    if (created !== null && declaration) this.line(`${declaration} = ${created};`);

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

  /**
   * `{value}` that depends on state. Text becomes a text node whose data is replaced; other
   * content is kept by the $$content helper, which replaces its nodes. Returns what to append.
   */
  protected liveChild(
    expression: ast.Expression,
    live: Live,
    sources: ReadonlySet<Source>,
  ): string {
    const type = this.typeOf(expression);
    const kind = type && widenLiterals(type).kind;
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
