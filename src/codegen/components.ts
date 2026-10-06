import type * as ast from '../ast.ts';
import { spreadFields } from '../checker/types.ts';
import { isConstant, isSimple, namesDeclaredIn, rootName } from './analysis.ts';
import { ControlFlowEmitter } from './control-flow.ts';
import { Reactive, type Live, type Source } from './reactive.ts';
import { ARROW, indentMore, lowerFirst, POSTFIX, upperFirst } from './syntax.ts';
import { inlinesUpdate, needed, resolveMarkers } from './updates.ts';

/**
 * Components, inlined where they are used: `<Card title="Hi" />` becomes a block with the code of
 * `Card`. A component with state also gets the functions that update its markup.
 */
export abstract class ComponentEmitter extends ControlFlowEmitter {
  private readonly componentNames = new Map<ast.ComponentDeclaration, Set<string>>();

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
      const fragment = `$$children${this.nextId()}`;
      this.line(`const ${fragment} = document.createDocumentFragment();`);
      this.children(fragment, node.children, live);
      values.set('children', fragment);
    }

    const result = `$$${lowerFirst(name)}${this.nextId()}`;
    this.line(`let ${result};`);
    const setters = new Map<string, string>();
    for (const [prop, [text, sources]] of reactiveProps) {
      const setter = `$$set${upperFirst(prop)}${this.nextId()}`;
      this.line(`let ${setter};`);
      live?.depend(sources, `${setter}(${text});`);
      setters.set(prop, setter);
    }

    const reactive = new Reactive(component, this.fn, setters.keys(), (sourceName, kind) => {
      const id = this.nextId();
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
}
