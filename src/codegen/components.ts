import type * as ast from '../ast.ts';
import { EarlyReturnEmitter } from './early-returns.ts';
import type { Reactive } from './reactive.ts';
import { type Live, type Source } from './reactive.ts';
import { ARROW, lowerFirst, upperFirst } from './syntax.ts';
import { resolveMarkers } from './updates.ts';
import { type Ending, hasEarlyReturn, hasMount } from './component-helpers.ts';

/**
 * Components, inlined where they are used: `<Card title="Hi" />` becomes a block with the code of
 * `Card`. A component with state also gets the functions that update its markup.
 *
 * A recursive component cannot be inlined into itself, so it becomes a function `$$Tree(...)`. It
 * takes the properties as arguments and returns the node and a function that sets the properties
 * again, which the parent calls when their values depend on its state.
 */

export abstract class ComponentEmitter extends EarlyReturnEmitter {
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
   * `mount() { ... }` becomes `$$mount(() => { ... })`. Its body runs later, like a handler: what
   * it changes updates the markup.
   */
  protected override mountStatement(node: ast.MountStatement): void {
    this.helpers.add('mount');
    this.inHandler++;
    try {
      const [, body] = this.withRendering(0, () => this.func([], node.body));
      this.line(`$$mount(() => ${this.mountNode ?? 'null'}, () => ${body});`);
    } finally {
      this.inHandler--;
    }
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
    const mountNode = hasMount(component) ? `$$mountNode${this.nextId()}` : null;
    this.line(mountNode ? `let ${result}, ${mountNode};` : `let ${result};`);
    const setters = new Map<string, string>();
    for (const [prop, [text, sources]] of reactiveProps) {
      const setter = `$$set${upperFirst(prop)}${this.nextId()}`;
      this.line(`let ${setter};`);
      live?.depend(sources, `${setter}(${text});`);
      setters.set(prop, setter);
    }

    const reactive = this.reactiveOf(component, setters.keys());
    const props = component.params.map((param): [string, 'const'] => [param.name.name, 'const']);
    const block = this.inComponent(reactive, mountNode, () =>
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
      const mountNode = hasMount(component) ? `$$mountNode${this.nextId()}` : null;
      const params = this.parameters(component.params, '');
      const body = this.inComponent(reactive, mountNode, () =>
        this.block(() => {
          this.line(mountNode ? `let ${result}, ${mountNode};` : `let ${result};`);
          this.body(component, result, reactive, { kind: 'function', props }, null);
        }),
      );
      this.line(`function $$${component.name.name}(${params}) ${resolveMarkers(body, reactive)}`);
    });
  }

  /** The statements of the body, then its markup. `label` is for early returns of a block. */
  protected body(
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
}
