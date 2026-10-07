import type * as ast from '../ast.ts';
import { spreadFields } from '../checker/types.ts';
import { isConstant, isSimple, namesDeclaredIn, rootName } from './analysis.ts';
import { containsReturn } from '../recursion.ts';
import { ControlFlowEmitter } from './control-flow.ts';
import { Block, Reactive, type Live, type Source } from './reactive.ts';
import { ARROW, indentMore, lowerFirst, POSTFIX, upperFirst } from './syntax.ts';
import { inlinesUpdate, needed, resolveMarkers } from './updates.ts';

/**
 * Components, inlined where they are used: `<Card title="Hi" />` becomes a block with the code of
 * `Card`. A component with state also gets the functions that update its markup.
 *
 * A recursive component cannot be inlined into itself, so it becomes a function `$$Tree(...)`. It
 * takes the properties as arguments and returns the node and a function that sets the properties
 * again, which the parent calls when their values depend on its state.
 */

/** How the code of a component ends: inlined into a block, or the body of a function. */
type Ending =
  | { kind: 'inline'; setters: ReadonlyMap<string, string> }
  | { kind: 'function'; props: readonly ast.Parameter[] };

/**
 * A component with an early `return`. The body runs once, so which markup it returns is decided
 * once, when it is created. Each returned markup gets its own update, kept in `view`.
 */
interface EarlyReturns {
  /** The function context of the body; a `return` in a nested function is that function's. */
  fn: unknown;
  result: string;
  reactive: Reactive;
  view: string;
  /** Leaves the body: `break $$body3;` or `return [$$tree4, $$setTree5];` */
  exit: string;
  /** In a function: the function that sets the properties, declared once for every return. */
  setter: string | null;
}

/** Marks where the setters of an inlined component with early returns go: before any return. */
const SETTERS = String.fromCharCode(0xe002);

export abstract class ComponentEmitter extends ControlFlowEmitter {
  private readonly componentNames = new Map<ast.ComponentDeclaration, Set<string>>();
  private earlyReturns: EarlyReturns | null = null;
  /** Setters waiting for their place at the top of an inlined component, by its result. */
  private readonly pendingSetters = new Map<string, string[]>();

  /** An early `return` in a component: its markup, then the exit from the body. */
  protected override statement(node: ast.Statement): void {
    const early = this.earlyReturns;
    if (early && node.kind === 'ReturnStatement' && this.fn === early.fn) {
      const [value] = node.values;
      if (value) this.withHoisting(true, () => this.returnedMarkup(value, early));
      this.line(early.exit);
      return;
    }
    super.statement(node);
  }

  /**
   * Inlines a component: its code goes into a block where its properties are constants. Attribute
   * values are computed before the block, so that the component's own names cannot hide the
   * names they refer to. In live markup, a property whose value depends on the parent's state is
   * a variable, and the parent's updates call a function that sets it.
   */
  protected override expand(
    node: ast.ElementExpression,
    component: ast.ComponentDeclaration,
    live: Live | null,
  ): string {
    const name = component.name.name;
    const isFunction = this.functionComponents.has(component);
    if (!isFunction) this.line(`// <${name}>`);
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
      const fragment = `$$children${this.nextId()}`;
      this.line(`const ${fragment} = document.createDocumentFragment();`);
      this.children(fragment, node.children, live);
      values.set('children', fragment);
    }
    if (isFunction) return this.callComponent(component, values, reactiveProps, live);

    const result = `$$${lowerFirst(name)}${this.nextId()}`;
    const label = hasEarlyReturn(component) ? `$$body${this.nextId()}` : null;
    this.line(`let ${result};`);
    const setters = new Map<string, string>();
    for (const [prop, [text, sources]] of reactiveProps) {
      const setter = `$$set${upperFirst(prop)}${this.nextId()}`;
      this.line(`let ${setter};`);
      live?.depend(sources, `${setter}(${text});`);
      setters.set(prop, setter);
    }

    const reactive = this.reactiveOf(component, setters.keys());
    const props = component.params.map((param): [string, 'const'] => [param.name.name, 'const']);
    const block = this.inComponent(reactive, () =>
      this.block(() =>
        this.withScope(props, () => {
          for (const param of component.params) {
            const value =
              values.get(param.name.name) ??
              (param.defaultValue ? this.expression(param.defaultValue, ARROW) : 'null');
            const keyword = setters.has(param.name.name) ? 'let' : 'const';
            this.line(`${keyword} ${this.name(param.name.name)} = ${value};`);
          }
          this.body(component, result, reactive, { kind: 'inline', setters }, label);
        }),
      ),
    );
    const code = this.placeSetters(resolveMarkers(block, reactive), result);
    this.line(label ? `${label}: ${code}` : code);
    return result;
  }

  /**
   * A recursive component: `function $$Tree(item) { ...; return [node, setItem]; }`. Every property
   * except `children` may get the caller's state, so all of them are sources here.
   */
  protected override componentFunction(component: ast.ComponentDeclaration): void {
    const props = component.params.filter((param) => param.name.name !== 'children');
    this.withFunction('none', component.params, () => {
      const reactive = this.reactiveOf(
        component,
        props.map((param) => param.name.name),
      );
      const result = `$$${lowerFirst(component.name.name)}${this.nextId()}`;
      const params = this.parameters(component.params, '');
      const body = this.inComponent(reactive, () =>
        this.block(() => {
          this.line(`let ${result};`);
          this.body(component, result, reactive, { kind: 'function', props }, null);
        }),
      );
      this.line(`function $$${component.name.name}(${params}) ${resolveMarkers(body, reactive)}`);
    });
  }

  /**
   * A use of a recursive component: a call of its function. The parent's updates call the
   * returned function with the new values of the properties that depend on its state.
   */
  private callComponent(
    component: ast.ComponentDeclaration,
    values: ReadonlyMap<string, string>,
    reactiveProps: ReadonlyMap<string, [string, Set<Source>]>,
    live: Live | null,
  ): string {
    const name = component.name.name;
    const id = this.nextId();
    const result = `$$${lowerFirst(name)}${id}`;
    // A missing property with a default value is left undefined, so that the default applies.
    const argument = (param: ast.Parameter) =>
      values.get(param.name.name) ?? (param.defaultValue ? 'undefined' : 'null');
    const args = withoutTrailingUndefined(component.params.map(argument));
    const call = `$$${name}(${args.join(', ')})`;
    if (!live || reactiveProps.size === 0) {
      this.line(`const [${result}] = ${call};`);
      return result;
    }
    const setter = `$$set${name}${id}`;
    this.line(`const [${result}, ${setter}] = ${call};`);
    const sources = new Set<Source>();
    for (const [, propSources] of reactiveProps.values()) {
      for (const source of propSources) sources.add(source);
    }
    const settable = component.params.filter((param) => param.name.name !== 'children');
    const setterArgs = withoutTrailingUndefined(
      settable.map((param) => reactiveProps.get(param.name.name)?.[0] ?? argument(param)),
    );
    live.depend(sources, `${setter}(${setterArgs.join(', ')});`);
    return result;
  }

  private reactiveOf(component: ast.ComponentDeclaration, props: Iterable<string>): Reactive {
    return new Reactive(component, this.fn, props, (sourceName, kind) => {
      const id = this.nextId();
      const update = `$$update${upperFirst(sourceName)}${id}`;
      return { id, name: sourceName, kind, update, dependents: [], writes: [] };
    });
  }

  /** Writes the code of a component with its own reactivity, apart from the enclosing one. */
  private inComponent<T>(reactive: Reactive, emit: () => T): T {
    const saved = {
      reactive: this.reactive,
      inHandler: this.inHandler,
      rendering: this.rendering,
      earlyReturns: this.earlyReturns,
    };
    this.reactive = reactive.sources.size > 0 ? reactive : null;
    this.inHandler = 0;
    this.rendering = 0;
    this.earlyReturns = null;
    try {
      return emit();
    } finally {
      this.reactive = saved.reactive;
      this.inHandler = saved.inHandler;
      this.rendering = saved.rendering;
      this.earlyReturns = saved.earlyReturns;
    }
  }

  /** `title, kind = "info"`: parameters with their default values, each name with a prefix. */
  private parameters(params: readonly ast.Parameter[], prefix: string): string {
    return params
      .map((param) => {
        const name = `${prefix}${prefix ? param.name.name : this.name(param.name.name)}`;
        return param.defaultValue
          ? `${name} = ${this.expression(param.defaultValue, ARROW)}`
          : name;
      })
      .join(', ');
  }

  /** The statements of the body, then its markup. `label` is for early returns of a block. */
  private body(
    component: ast.ComponentDeclaration,
    result: string,
    reactive: Reactive,
    ending: Ending,
    label: string | null,
  ): void {
    const body = component.body.body;
    const last = body.at(-1);
    const setup = last?.kind === 'ReturnStatement' ? body.slice(0, -1) : body;
    const early = hasEarlyReturn(component)
      ? this.prepareEarlyReturns(result, reactive, ending, label, component)
      : null;
    const saved = this.earlyReturns;
    this.earlyReturns = early;
    try {
      this.blockStatements(setup, () => {
        if (last?.kind !== 'ReturnStatement' || !last.values[0]) return;
        const previous = setup.at(-1);
        if (previous && this.blankLineBetween(previous, last)) this.blankLine();
        const value = last.values[0];
        this.withHoisting(true, () => {
          if (early) this.lastReturn(value, ending, early);
          else this.markup(value, result, reactive, ending);
        });
      });
    } finally {
      this.earlyReturns = saved;
    }
  }

  /** Declarations that every return needs, written before the statements of the body. */
  private prepareEarlyReturns(
    result: string,
    reactive: Reactive,
    ending: Ending,
    label: string | null,
    component: ast.ComponentDeclaration,
  ): EarlyReturns {
    const id = this.nextId();
    const view = `$$view${id}`;
    let exit = `break ${label};`;
    let setter: string | null = null;
    if (ending.kind === 'function') {
      setter = ending.props.length > 0 ? `$$set${component.name.name}${id}` : null;
      exit = `return [${result}${setter ? `, ${setter}` : ''}];`;
    } else if (ending.setters.size > 0) {
      this.line(`${SETTERS}${result}${SETTERS}`);
    }
    if (reactive.sources.size > 0) this.line(`let ${view};`);
    return { fn: this.fn, result, reactive, view, exit, setter };
  }

  /** The markup of one `return`: a block with its own update, which `view` keeps. */
  private returnedMarkup(value: ast.Expression, early: EarlyReturns): void {
    const { result, reactive, view } = early;
    if (reactive.sources.size === 0) {
      if (value.kind === 'ElementExpression' && !this.componentOf(value)) {
        this.build(value, result, null);
      } else {
        this.line(`${result} = ${this.expression(value, ARROW)};`);
      }
      return;
    }
    const block = new Block(reactive);
    const root =
      value.kind === 'ElementExpression'
        ? this.create(value, block)
        : this.expression(value, ARROW);
    if (block.statements.length > 0) {
      const body = this.block(() => {
        for (const statement of block.statements) this.line(indentMore(statement));
      });
      this.line(`${view} = () => ${body};`);
      reactive.depend(block.sources, `${view}?.();`);
    }
    this.line(`${result} = ${root};`);
  }

  /** The last `return` of a component with early returns, then the updates and the setters. */
  private lastReturn(value: ast.Expression, ending: Ending, early: EarlyReturns): void {
    const { result, reactive } = early;
    this.returnedMarkup(value, early);
    const functions = this.updateFunctions(result, reactive);
    if (ending.kind === 'inline') {
      // An early return leaves the block, so the setters are assigned at its top.
      const texts = [...ending.setters].map(
        ([prop, setter]) => `${setter} = ($$${prop}) => ${this.setterBody([prop], reactive)};`,
      );
      if (texts.length > 0) this.pendingSetters.set(result, texts);
      return;
    }
    if (early.setter) {
      this.blankLine();
      const params = this.parameters(ending.props, '$$');
      const names = ending.props.map((param) => param.name.name);
      this.line(`function ${early.setter}(${params}) ${this.setterBody(names, reactive)}`);
    } else if (functions > 0) {
      this.blankLine();
    }
    this.line(early.exit);
  }

  /** `{ title = $$title; ...updates of what reads it... }` */
  private setterBody(props: readonly string[], reactive: Reactive): string {
    const dependents = new Set<string>();
    for (const prop of props) {
      for (const dependent of reactive.sources.get(prop)?.dependents ?? [])
        dependents.add(dependent);
    }
    return this.block(() => {
      for (const prop of props) this.line(`${this.name(prop)} = $$${prop};`);
      for (const dependent of dependents) this.line(indentMore(dependent));
    });
  }

  /** Puts the setters of an inlined component with early returns at the top of its block. */
  private placeSetters(code: string, result: string): string {
    const texts = this.pendingSetters.get(result);
    const marker = `${SETTERS}${result}${SETTERS}`;
    if (!code.includes(marker)) return code;
    this.pendingSetters.delete(result);
    return code.replace(
      new RegExp(`^([ \\t]*)${marker.replace(/\$/g, '\\$')}\n`, 'm'),
      (_, indent: string) => (texts ?? []).map((text) => `${indent}${text}\n`).join(''),
    );
  }

  /** Functions that update the markup after changes of state; returns how many were written. */
  private updateFunctions(result: string, reactive: Reactive): number {
    let functions = 0;
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
    return functions;
  }

  /** The markup a component returns, then the functions that update it. */
  private markup(value: ast.Expression, result: string, reactive: Reactive, ending: Ending): void {
    if (reactive.sources.size === 0) {
      if (value.kind === 'ElementExpression' && !this.componentOf(value)) {
        this.build(value, result, null);
      } else {
        this.line(`${result} = ${this.expression(value, ARROW)};`);
      }
      if (ending.kind === 'function') this.line(`return [${result}];`);
      return;
    }
    const root =
      value.kind === 'ElementExpression'
        ? this.create(value, reactive)
        : this.expression(value, ARROW);

    let functions = 0;
    const setters = ending.kind === 'inline' ? ending.setters : new Map<string, string>();
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
    functions += this.updateFunctions(result, reactive);
    if (functions > 0) this.blankLine();
    this.line(`${result} = ${root};`);
    if (ending.kind === 'function') this.functionResult(result, reactive, ending.props);
  }

  /** `return [node, (...) => { ... }]`: the node and the function that sets the properties. */
  private functionResult(
    result: string,
    reactive: Reactive,
    props: readonly ast.Parameter[],
  ): void {
    if (props.length === 0) {
      this.line(`return [${result}];`);
      return;
    }
    const dependents = new Set<string>();
    for (const param of props) {
      for (const dependent of reactive.sources.get(param.name.name)?.dependents ?? []) {
        dependents.add(dependent);
      }
    }
    const setter = this.block(() => {
      for (const param of props) this.line(`${this.name(param.name.name)} = $$${param.name.name};`);
      for (const dependent of dependents) this.line(indentMore(dependent));
    });
    this.line(`return [${result}, (${this.parameters(props, '$$')}) => ${setter}];`);
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
    // Arguments of a function component cannot be hidden by its names: they are not inlined.
    let declared = this.functionComponents.has(component)
      ? new Set<string>()
      : this.componentNames.get(component);
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
}

/** `f(a, undefined, undefined)` → `f(a)`: missing arguments are undefined anyway. */
function withoutTrailingUndefined(args: string[]): string[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === 'undefined') end--;
  return args.slice(0, end);
}

/** Whether a component returns before the end of its body. */
function hasEarlyReturn(component: ast.ComponentDeclaration): boolean {
  return component.body.body.slice(0, -1).some(containsReturn);
}
