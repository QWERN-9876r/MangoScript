import type * as ast from '../ast.ts';
import { domProperty } from '../checker/dom.ts';
import { spreadFields, type Type } from '../checker/types.ts';
import { forEachChild } from '../walk.ts';
import { declarationsOf, namesDeclaredIn, startsWithObjectLiteral } from './analysis.ts';
import { Block, Reactive, type Live, type Source, type Write } from './reactive.ts';
import { StatementEmitter } from './statements.ts';
import { ARROW, arrayPattern, CONDITIONAL, POSTFIX } from './syntax.ts';

/** What can be inside markup: children of an element, or statements of a markup block. */
type Content = ast.JsxChild | ast.Statement;

type ControlStatement = ast.JsxStatementContainer['statement'];

/**
 * Markup: `<a href="/">Ссылка {name}</a>` becomes statements that create the element. When the
 * expression is evaluated exactly once they go before the statement that contains it; otherwise
 * the element is created inside a function that is called right away.
 *
 * Markup that a component creates once (what it returns, and elements declared at the top level
 * of its body) is live: parts that read state are updated when the state changes. Each state
 * variable gets an update function; every place that changes the variable calls it. Those places
 * are written before it is known what the update needs, so they get a marker that is replaced at
 * the end of the component: by the call, by the only update statement, or by nothing.
 *
 * `{if ...}`, `{switch ...}` and `{for ...}` in markup become plain JS control flow that appends
 * elements. In live markup, when they depend on state, helpers keep their content between markers
 * instead, and their blocks are functions that create the content and return its update.
 */
export abstract class ElementEmitter extends StatementEmitter {
  /** Counter for `$$li1`, `$$div2`, ... */
  private elementCount = 0;
  private readonly componentNames = new Map<ast.ComponentDeclaration, Set<string>>();
  /** The component whose code is being written, if it has state or reactive properties. */
  private reactive: Reactive | null = null;
  /** Inside event handlers, which cannot run before the markup exists. */
  private inHandler = 0;
  /**
   * Inside code that runs while live markup is created or updated: its expressions, the functions
   * they call and the callbacks they pass (`items.map(item => ...)`). Changes there do not update
   * the markup, which would update it again; code that runs later (handlers) is not included.
   */
  private rendering = 0;
  /** The element that elements of markup blocks are appended to, in plain control flow. */
  private contentTarget: string | null = null;

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

  /** After a statement that changes state, the update of what depends on it. */
  protected override statement(node: ast.Statement): void {
    const { reactive } = this;
    if (reactive && this.fn === reactive.setup && reactive.declaresRenderFunction(node)) {
      this.withRendering(this.rendering + 1, () => super.statement(node));
      return;
    }
    const written = this.changedBy(node);
    if (written.length === 0) {
      super.statement(node);
      return;
    }
    switch (node.kind) {
      case 'ReturnStatement':
      case 'ThrowStatement': {
        // The update goes between computing the value and leaving the function.
        const values = node.kind === 'ThrowStatement' ? [node.argument] : node.values;
        const temp = this.temp();
        this.withHoisting(true, () => {
          const rendered = values.map((value) => this.expression(value, ARROW));
          const value = rendered.length === 1 ? rendered[0]! : `[${rendered.join(', ')}]`;
          this.line(`const ${temp} = ${value};`);
        });
        this.updates(written);
        this.line(`${node.kind === 'ThrowStatement' ? 'throw' : 'return'} ${temp};`);
        return;
      }
      case 'IfStatement':
      case 'ForStatement':
      case 'ForInStatement':
      case 'SwitchStatement':
        // The change is in a condition: update at the start of every branch, before anything in
        // it can leave the function, and after the statement.
        super.statement(withFirst(node, (position) => this.markers(written, position)));
        this.updates(written);
        return;
      default:
        super.statement(node);
        this.updates(written);
    }
  }

  protected override changesState(body: ast.Expression): boolean {
    return this.changedBy(body).length > 0;
  }

  /** State that a statement changes, when it runs after the component's markup is created. */
  private changedBy(node: ast.Node): Source[] {
    const { reactive } = this;
    if (!reactive || this.fn === reactive.setup || this.rendering > 0) return [];
    return [...reactive.writtenBy(node, (expression) => this.typeOf(expression))];
  }

  private withRendering<T>(rendering: number, emit: () => T): T {
    const saved = this.rendering;
    this.rendering = rendering;
    try {
      return emit();
    } finally {
      this.rendering = saved;
    }
  }

  private updates(sources: readonly Source[]): void {
    for (const source of sources) this.line(`${this.write(source)};`);
  }

  /** Marker statements for the start of a branch, at `position` in the source. */
  private markers(sources: readonly Source[], position: number): ast.Statement[] {
    return sources.map((source) => {
      const expression: ast.Identifier = {
        kind: 'Identifier',
        name: this.write(source),
        start: position,
        end: position,
      };
      return { kind: 'ExpressionStatement', expression, start: position, end: position };
    });
  }

  /** Records a place that changes a source and returns its marker; see resolveMarkers. */
  private write(source: Source, skip: number | null = null): string {
    source.writes.push({ early: this.inHandler === 0, skip });
    return `\uE000${source.id}${skip === null ? '' : `:${skip}`}\uE001`;
  }

  /** Writes the code for an element or a component and returns the variable with the result. */
  private create(node: ast.ElementExpression, live: Live | null): string {
    const component = this.componentOf(node);
    return component ? this.expand(node, component, live) : this.build(node, null, live);
  }

  private componentOf(node: ast.ElementExpression): ast.ComponentDeclaration | undefined {
    return node.tag ? this.components.get(node.tag.name) : undefined;
  }

  /**
   * Inlines a component: its code goes into a block where its properties are constants. Attribute
   * values are computed before the block, so that the component's own names cannot hide the
   * names they refer to. In live markup, a property whose value depends on the parent's state is
   * a variable, and the parent's updates call a function that sets it.
   */
  private expand(
    node: ast.ElementExpression,
    component: ast.ComponentDeclaration,
    live: Live | null,
  ): string {
    const name = component.name.name;
    this.line(`// <${name}>`);
    const values = new Map<string, string>();
    const reactiveProps = new Map<string, [string, Set<Source>]>();
    for (const attribute of node.attributes) {
      if (attribute.kind === 'JsxSpreadAttribute') {
        this.spreadProps(attribute.argument, component, live, values, reactiveProps);
        continue;
      }
      const prop = attribute.name.name;
      values.set(prop, this.prop(attribute, component));
      reactiveProps.delete(prop);
      const { value } = attribute;
      if (live && value && value.kind !== 'EventHandler') {
        const sources = live.dependencies(value);
        if (sources.size > 0) reactiveProps.set(prop, [this.liveExpression(value), sources]);
      }
    }
    if (component.params.some((param) => param.name.name === 'children')) {
      const fragment = `$$children${++this.elementCount}`;
      this.line(`const ${fragment} = document.createDocumentFragment();`);
      this.children(fragment, node.children, live);
      values.set('children', fragment);
    }

    const result = `$$${lowerFirst(name)}${++this.elementCount}`;
    this.line(`let ${result};`);
    const setters = new Map<string, string>();
    for (const [prop, [text, sources]] of reactiveProps) {
      const setter = `$$set${upperFirst(prop)}${++this.elementCount}`;
      this.line(`let ${setter};`);
      live?.depend(sources, `${setter}(${text});`);
      setters.set(prop, setter);
    }

    const reactive = new Reactive(component, this.fn, setters.keys(), (sourceName, kind) => {
      const id = ++this.elementCount;
      const update = `$$update${upperFirst(sourceName)}${id}`;
      return { id, name: sourceName, kind, update, dependents: [], writes: [] };
    });
    const props = component.params.map((param): [string, 'const'] => [param.name.name, 'const']);
    const saved = { reactive: this.reactive, inHandler: this.inHandler, rendering: this.rendering };
    this.reactive = reactive.sources.size > 0 ? reactive : null;
    this.inHandler = 0;
    this.rendering = 0;
    let block: string;
    try {
      block = this.block(() =>
        this.withScope(props, () => {
          for (const param of component.params) {
            const value =
              values.get(param.name.name) ??
              (param.defaultValue ? this.expression(param.defaultValue, ARROW) : 'null');
            const keyword = setters.has(param.name.name) ? 'let' : 'const';
            this.line(`${keyword} ${this.name(param.name.name)} = ${value};`);
          }
          const body = component.body.body;
          const last = body.at(-1);
          const setup = last?.kind === 'ReturnStatement' ? body.slice(0, -1) : body;
          this.blockStatements(setup, () => {
            if (last?.kind !== 'ReturnStatement' || !last.values[0]) return;
            const previous = setup.at(-1);
            if (previous && this.blankLineBetween(previous, last)) this.blankLine();
            const value = last.values[0];
            this.withHoisting(true, () => this.markup(value, result, reactive, setters));
          });
        }),
      );
    } finally {
      this.reactive = saved.reactive;
      this.inHandler = saved.inHandler;
      this.rendering = saved.rendering;
    }
    this.line(resolveMarkers(block, reactive));
    return result;
  }

  /** The markup a component returns, then the functions that update it. */
  private markup(
    value: ast.Expression,
    result: string,
    reactive: Reactive,
    setters: ReadonlyMap<string, string>,
  ): void {
    if (reactive.sources.size === 0) {
      if (value.kind === 'ElementExpression' && !this.componentOf(value)) {
        this.build(value, result, null);
      } else {
        this.line(`${result} = ${this.expression(value, ARROW)};`);
      }
      return;
    }
    const root =
      value.kind === 'ElementExpression'
        ? this.create(value, reactive)
        : this.expression(value, ARROW);

    let functions = 0;
    for (const [prop, setter] of setters) {
      const source = reactive.sources.get(prop)!;
      const param = `$$${prop}`;
      const body = this.block(() => {
        this.line(`${this.name(prop)} = ${param};`);
        for (const dependent of source.dependents) this.line(indentMore(dependent));
      });
      this.blankLine();
      this.line(`${setter} = (${param}) => ${body};`);
      functions++;
    }
    for (const source of reactive.sources.values()) {
      const called = source.writes.some((write) => needed(source, write).length > 0);
      if (source.kind !== 'state' || !called || inlinesUpdate(source)) continue;
      const body = this.block(() => {
        // A function of the body may change the state while the markup is being created.
        if (source.writes.some((write) => write.early)) this.line(`if (!${result}) return;`);
        for (const dependent of source.dependents) this.line(indentMore(dependent));
      });
      this.blankLine();
      this.line(`function ${source.update}() ${body}`);
      functions++;
    }
    if (functions > 0) this.blankLine();
    this.line(`${result} = ${root};`);
  }

  /**
   * The value of a component property. Literals and names that the component does not redeclare
   * go into its code as they are; anything else is computed before the block into a temporary.
   */
  private prop(attribute: ast.JsxAttribute, component: ast.ComponentDeclaration): string {
    const { value } = attribute;
    if (value === null) return 'true';
    if (value.kind === 'EventHandler') {
      const temp = this.temp();
      this.line(`const ${temp} = ${this.handler(value)};`);
      return temp;
    }
    return this.propValue(value, component);
  }

  private propValue(value: ast.Expression, component: ast.ComponentDeclaration): string {
    let declared = this.componentNames.get(component);
    if (!declared) {
      declared = namesDeclaredIn(component);
      this.componentNames.set(component, declared);
    }
    const root = rootName(value);
    if (isConstant(value) || (isSimple(value) && root !== null && !declared.has(root))) {
      return this.expression(value, ARROW);
    }
    // A function given to the component runs later, not while the markup is being created.
    const text =
      value.kind === 'ArrowFunction' || value.kind === 'FuncExpression'
        ? this.withRendering(0, () => this.expression(value, ARROW))
        : this.expression(value, ARROW);
    const temp = this.temp();
    this.line(`const ${temp} = ${text};`);
    return temp;
  }

  /**
   * `<Product {...product} />`: properties that the object has get their values from it. Later
   * attributes override them. The object is computed once, before the component's block.
   */
  private spreadProps(
    argument: ast.Expression,
    component: ast.ComponentDeclaration,
    live: Live | null,
    values: Map<string, string>,
    reactiveProps: Map<string, [string, Set<Source>]>,
  ): void {
    const type = this.typeOf(argument);
    // Without a type, the object may have any of the properties.
    const fields =
      type && type.kind !== 'any' && type.kind !== 'unknown' ? spreadFields(type) : null;
    const params = component.params.filter(
      (param) => param.name.name !== 'children' && (fields === null || fields.has(param.name.name)),
    );
    if (params.length === 0) return;
    const object = this.propValue(argument, component);
    const sources = live?.dependencies(argument);
    const liveObject = sources && sources.size > 0 ? this.liveExpression(argument, POSTFIX) : null;
    for (const param of params) {
      const name = param.name.name;
      const read = `${object}.${name}`;
      values.set(
        name,
        fields === null && param.defaultValue
          ? `${read} ?? ${this.expression(param.defaultValue, POSTFIX)}`
          : read,
      );
      if (sources && liveObject) reactiveProps.set(name, [`${liveObject}.${name}`, sources]);
      else reactiveProps.delete(name);
    }
  }

  /**
   * Writes the statements that create the element and returns the name of its variable.
   * `declaration` is `const link` for `const link = <a>`; otherwise a temporary name is used.
   */
  private build(
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

  private elementName(tag: string | null): string {
    const base = tag === null ? 'fragment' : /^[a-z][a-z0-9]*$/.test(tag) ? tag : 'element';
    return `$$${base}${++this.elementCount}`;
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
    if (!sources || sources.size === 0) {
      this.line(statement(this.expression(value, ARROW)));
      return;
    }
    const text = statement(this.liveExpression(value));
    this.line(text);
    live!.depend(sources, text);
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

  /** `onClick={count++}` becomes `() => { count++; }`; a function is used as it is. */
  private handler(value: ast.JsxAttribute['value']): string {
    return this.withRendering(0, () => this.handlerFunction(value));
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
   * Children are appended in order; consecutive ones that need no checks go into one `append`.
   * Values whose type allows null, or is not known, are checked before they are appended. The
   * statements of markup blocks are handled here too.
   */
  private children(element: string, children: readonly Content[], live: Live | null): void {
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

  /**
   * `{value}` that depends on state. Text becomes a text node whose data is replaced; other
   * content is kept by the $$content helper, which replaces its nodes. Returns what to append.
   */
  private liveChild(expression: ast.Expression, live: Live, sources: ReadonlySet<Source>): string {
    const kind = this.typeOf(expression)?.kind;
    const id = ++this.elementCount;
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
   * `{if ...}`, `{switch ...}` or `{for ...}` that depends on state: a helper keeps its content
   * between markers, and the updates of the enclosing markup call its update. Returns what to
   * append.
   */
  private liveControl(
    statement: ControlStatement,
    live: Live,
    sources: ReadonlySet<Source>,
  ): string {
    const id = ++this.elementCount;
    const kind =
      statement.kind === 'IfStatement'
        ? 'if'
        : statement.kind === 'SwitchStatement'
          ? 'switch'
          : 'for';
    const name = `$$${kind}${id}`;
    const update = `$$update${upperFirst(kind)}${id}`;
    let call: string;
    switch (statement.kind) {
      case 'IfStatement':
      case 'SwitchStatement': {
        const [choose, blocks] =
          statement.kind === 'IfStatement'
            ? this.ifBranches(statement, live)
            : this.switchBranches(statement, live);
        this.helpers.add('branches');
        call = `$$branches(${choose}, [${blocks.join(', ')}])`;
        break;
      }
      case 'ForInStatement': {
        this.helpers.add('list');
        const items = this.liveFunction(statement.iterable);
        call = `$$list(${items}, ${this.blockCreator(statement.body.body, live, statement)})`;
        break;
      }
      case 'ForStatement':
        // Without items to find the blocks by, the loop runs again and creates new content.
        this.helpers.add('content');
        call = `$$content(${this.loopContent(statement)})`;
        break;
    }
    this.line(`const [${name}, ${update}] = ${call};`);
    live.depend(sources, `${update}();`);
    return name;
  }

  /** The choice of an if/else chain, `() => a ? 0 : b ? 1 : -1`, and its blocks. */
  private ifBranches(node: ast.IfStatement, live: Live): [string, string[]] {
    const conditions: string[] = [];
    const blocks: string[] = [];
    let current: ast.IfStatement | ast.BlockStatement | null = node;
    while (current?.kind === 'IfStatement') {
      conditions.push(this.liveExpression(current.condition, CONDITIONAL + 1));
      blocks.push(this.blockCreator(current.consequent.body, live));
      current = current.alternate;
    }
    if (current) blocks.push(this.blockCreator(current.body, live));
    let choose = current ? String(conditions.length) : '-1';
    for (let i = conditions.length - 1; i >= 0; i--) choose = `${conditions[i]} ? ${i} : ${choose}`;
    return [`() => ${choose}`, blocks];
  }

  /** The choice of a switch: the same switch, returning the number of the case. */
  private switchBranches(node: ast.SwitchStatement, live: Live): [string, string[]] {
    const blocks = node.cases.map((switchCase) => this.blockCreator(switchCase.body, live));
    const choice: ast.SwitchStatement = {
      ...node,
      cases: node.cases.map((switchCase, i) => ({
        ...switchCase,
        body: [returnNumber(i, switchCase)],
      })),
    };
    const hasDefault = node.cases.some((switchCase) => switchCase.tests.length === 0);
    const body = this.withFunction('none', [], () =>
      this.withRendering(this.rendering + 1, () =>
        this.block(() => {
          this.statement(choice);
          if (!hasDefault) this.line('return -1;');
        }),
      ),
    );
    return [`() => ${body}`, blocks];
  }

  /**
   * The function that creates a block of markup control flow:
   * `(item, index) => { ...; return [fragment, update]; }`. Parts of the block that depend on
   * state go into its update.
   */
  private blockCreator(
    statements: readonly ast.Statement[],
    parent: Live,
    loop?: ast.ForInStatement,
  ): string {
    const block = new Block(parent);
    const params = loop ? [loop.value, ...(loop.key ? [loop.key] : [])].map(parameter) : [];
    return this.withFunction('none', params, () =>
      this.withRendering(this.rendering + 1, () => {
        const paramList = this.params(params);
        const fragment = `$$block${++this.elementCount}`;
        const body = this.block(() =>
          this.withScope(declarationsOf(statements), () => {
            this.line(`const ${fragment} = document.createDocumentFragment();`);
            this.children(fragment, statements, block);
            // The block of an item that stays gets the item's new position.
            const key = loop?.key && loop.key.name !== '_' ? this.name(loop.key.name) : null;
            const updates = [...(key ? [`${key} = $$index;`] : []), ...block.statements];
            if (updates.length === 0) {
              this.line(`return [${fragment}];`);
              return;
            }
            const update = this.block(() => {
              for (const statement of updates) this.line(indentMore(statement));
            });
            this.line(`return [${fragment}, (${key ? '$$index' : ''}) => ${update}];`);
          }),
        );
        return `(${paramList}) => ${body}`;
      }),
    );
  }

  /** A classic `for` loop in live markup: a function that runs it and returns the content. */
  private loopContent(statement: ast.ForStatement): string {
    return this.withFunction('none', [], () =>
      this.withRendering(this.rendering + 1, () => {
        const fragment = `$$block${++this.elementCount}`;
        const body = this.block(() => {
          this.line(`const ${fragment} = document.createDocumentFragment();`);
          this.withContentTarget(fragment, () => this.statement(statement));
          this.line(`return ${fragment};`);
        });
        return `() => ${body}`;
      }),
    );
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

  private withContentTarget<T>(element: string, emit: () => T): T {
    const saved = this.contentTarget;
    this.contentTarget = element;
    try {
      return emit();
    } finally {
      this.contentTarget = saved;
    }
  }

  /** `() => value`, evaluated by a helper when the markup is created and on updates. */
  private liveFunction(node: ast.Expression): string {
    const text = this.liveExpression(node);
    return `() => ${startsWithObjectLiteral(node) ? `(${text})` : text}`;
  }

  /**
   * An expression that is evaluated again on updates: elements inside it are created in place,
   * so that each evaluation creates new ones.
   */
  private liveExpression(node: ast.Expression, precedence = ARROW): string {
    return this.withRendering(this.rendering + 1, () =>
      this.withHoisting(false, () => this.expression(node, precedence)),
    );
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

/**
 * Replaces the markers of a component's sources: by the call of the update function, by the only
 * update statement, or by nothing when no markup depends on the source.
 */
function resolveMarkers(block: string, reactive: Reactive): string {
  const sources = new Map<number, Source>();
  for (const source of reactive.sources.values()) sources.set(source.id, source);
  return block.replace(
    /^([ \t]*)\uE000(\d+)(?::(\d+))?\uE001;\n/gm,
    (line, indent: string, id: string, skip: string | undefined) => {
      const source = sources.get(Number(id));
      if (!source) return line;
      const dependents = needed(source, { early: false, skip: skip ? Number(skip) : null });
      if (dependents.length === 0) return '';
      const text = inlinesUpdate(source) ? dependents[0]! : `${source.update}();`;
      return `${indent}${text}\n`;
    },
  );
}

/** The update statements that a place changing the source needs. */
function needed(source: Source, write: Write): string[] {
  return source.dependents.filter((_, i) => i !== write.skip);
}

/** One place changes the source, after the markup exists, and needs one update statement. */
function inlinesUpdate(source: Source): boolean {
  const [write] = source.writes;
  if (source.writes.length !== 1 || write!.early) return false;
  const dependents = needed(source, write!);
  return dependents.length === 1 && !dependents[0]!.includes('\n');
}

/**
 * A copy of an if/for/switch statement with statements added at the start of every branch or
 * loop body; `first` gets the position where they go.
 */
function withFirst(
  node: ast.IfStatement | ast.ForStatement | ast.ForInStatement | ast.SwitchStatement,
  first: (position: number) => ast.Statement[],
): ast.Statement {
  const prepend = (body: readonly ast.Statement[], end: number) => [
    ...first(body[0]?.start ?? end),
    ...body,
  ];
  const block = (node: ast.BlockStatement): ast.BlockStatement => ({
    ...node,
    body: prepend(node.body, node.end - 1),
  });
  switch (node.kind) {
    case 'IfStatement': {
      const { alternate } = node;
      return {
        ...node,
        consequent: block(node.consequent),
        alternate:
          alternate === null
            ? null
            : alternate.kind === 'IfStatement'
              ? (withFirst(alternate, first) as ast.IfStatement)
              : block(alternate),
      };
    }
    case 'ForStatement':
    case 'ForInStatement':
      return { ...node, body: block(node.body) };
    case 'SwitchStatement':
      return {
        ...node,
        cases: node.cases.map((switchCase) => ({
          ...switchCase,
          body: prepend(switchCase.body, switchCase.end),
        })),
      };
  }
}

/** `return 2` for the choice of a switch case. */
function returnNumber(value: number, at: ast.NodeBase): ast.ReturnStatement {
  const number: ast.NumberLiteral = {
    kind: 'NumberLiteral',
    value,
    raw: String(value),
    start: at.start,
    end: at.start,
  };
  return { kind: 'ReturnStatement', values: [number], start: at.start, end: at.start };
}

/** A loop variable as a parameter of the function that creates the loop's blocks. */
function parameter(name: ast.Identifier): ast.Parameter {
  return {
    kind: 'Parameter',
    name,
    type: null,
    defaultValue: null,
    start: name.start,
    end: name.end,
  };
}

/** A statement written at block level goes one level deeper into a function. */
function indentMore(text: string): string {
  return text.replace(/\n/g, '\n  ');
}

function upperFirst(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
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
