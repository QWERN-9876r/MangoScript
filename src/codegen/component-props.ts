import type * as ast from '../ast.ts';
import { spreadFields } from '../checker/types.ts';
import { declaredNames } from '../names.ts';
import { isConstant, isSimple, rootName } from './analysis.ts';
import { ControlFlowEmitter } from './control-flow.ts';
import { Reactive, type Live, type Source } from './reactive.ts';
import { ARROW, indentMore, lowerFirst, POSTFIX, upperFirst } from './syntax.ts';
import { type EarlyReturns, withoutTrailingUndefined } from './component-helpers.ts';

/** The properties of components: their values, spread objects, and calls of function components. */

export abstract class ComponentPropsEmitter extends ControlFlowEmitter {
  protected readonly componentNames = new Map<ast.ComponentDeclaration, Set<string>>();

  protected earlyReturns: EarlyReturns | null = null;

  /** Setters waiting for their place at the top of an inlined component, by its result. */
  protected readonly pendingSetters = new Map<string, string[]>();

  /**
   * In a component with `mount()`: the variable that gets its first node once the markup is
   * created, so that `$$mount` can wait until that node is in the document.
   */
  protected mountNode: string | null = null;

  /**
   * A use of a recursive component: a call of its function. The parent's updates call the
   * returned function with the new values of the properties that depend on its state.
   */
  protected callComponent(
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
    const fn = this.functionNames.get(component) ?? `$$${name}`;
    const call = `${fn}(${args.join(', ')})`;

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

  protected reactiveOf(component: ast.ComponentDeclaration, props: Iterable<string>): Reactive {
    return new Reactive(component, this.fn, props, (sourceName, kind) => {
      const id = this.nextId();
      // `$$card$price`, an argument of a decorator, is updated by `$$updateCard$price3`.
      const update = `$$update${upperFirst(sourceName.replace(/^\$\$/, ''))}${id}`;

      return { id, name: sourceName, kind, update, dependents: [], writes: [] };
    });
  }

  /** `title, kind = "info"`: parameters with their default values, each name with a prefix. */
  protected parameters(params: readonly ast.Parameter[], prefix: string): string {
    return params
      .map((param) => {
        const name = `${prefix}${prefix ? param.name.name : this.name(param.name.name)}`;

        return param.defaultValue
          ? `${name} = ${this.expression(param.defaultValue, ARROW)}`
          : name;
      })
      .join(', ');
  }

  /** `{ title = $$title; ...updates of what reads it... }` */
  protected setterBody(props: readonly string[], reactive: Reactive): string {
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

  /** `return [node, (...) => { ... }]`: the node and the function that sets the properties. */
  protected functionResult(
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
  protected prop(attribute: ast.JsxAttribute, component: ast.ComponentDeclaration): string {
    const { value } = attribute;

    if (value === null) return 'true';
    if (value.kind === 'EventHandler') {
      const temp = this.temp();

      this.line(`const ${temp} = ${this.handler(value)};`);

      return temp;
    }

    return this.propValue(value, component);
  }

  protected propValue(value: ast.Expression, component: ast.ComponentDeclaration): string {
    // Arguments of a function component cannot be hidden by its names: they are not inlined.
    let declared = this.functionComponents.has(component)
      ? new Set<string>()
      : this.componentNames.get(component);

    if (!declared) {
      declared = declaredNames(component);
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
  protected spreadProps(
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
      const { name } = param.name;
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
