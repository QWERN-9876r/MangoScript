import type * as ast from '../ast.ts';
import { isNullable, type ComponentParam } from '../checker/types.ts';
import { isConstant, isSimple } from './analysis.ts';
import { withoutTrailingUndefined } from './component-helpers.ts';
import { ComponentPropsEmitter } from './component-props.ts';
import type { Live, Source } from './reactive.ts';
import { ARROW, BINARY, lowerFirst, POSTFIX, upperFirst } from './syntax.ts';

/**
 * Tags that take the component from a value: `<section.content title={title} />` calls the
 * function of the component, `section.content(title)`, with the properties in the order of the
 * type of the value, `comp(title string)`. Like the call of a function component, it returns the
 * node and, when the parent's state changes a property, the function that sets them again. When
 * the value itself depends on state, the component is created again each time it changes:
 * `$$dynamic` keeps it between markers, in a block of its own.
 */
export abstract class ComponentValueEmitter extends ComponentPropsEmitter {
  /** Tags inside the blocks of `$$dynamic`: they call the component the block gets. */
  private readonly fixedComponents = new Map<ast.ElementExpression, string>();

  protected override valueTag(
    node: ast.ElementExpression,
    value: ast.Expression,
    live: Live | null,
  ): string {
    const type = this.typeOf(value);

    if (!type) {
      throw new Error(
        `<${node.tag!.name}> takes its component from a value, whose type gives the order of the properties: compile it with type checking`,
      );
    }

    const params = type.kind === 'component' ? type.params : [];
    const fixed = this.fixedComponents.get(node);

    if (fixed === undefined && live && live.dependencies(value).size > 0) {
      return this.dynamicTag(node, value, live);
    }

    return this.callValue(node, fixed ?? this.expression(value, POSTFIX), params, live);
  }

  /** `$$dynamic(() => page, ($$component3) => { ...; return [block, update]; })` */
  private dynamicTag(node: ast.ElementExpression, value: ast.Expression, live: Live): string {
    const id = this.nextId();
    const base = resultName(node);
    const name = `$$${base}${id}`;
    const update = `$$update${upperFirst(base)}${id}`;
    const component: ast.Identifier = {
      kind: 'Identifier',
      name: `$$component${id}`,
      start: node.start,
      end: node.start,
    };
    const statement: ast.JsxElementStatement = {
      kind: 'JsxElementStatement',
      element: node,
      start: node.start,
      end: node.end,
    };

    this.fixedComponents.set(node, component.name);

    let create: string;

    try {
      create = this.blockCreator([statement], live, undefined, component);
    } finally {
      this.fixedComponents.delete(node);
    }

    this.helpers.add('dynamic');
    this.line(`const [${name}, ${update}] = $$dynamic(${this.liveFunction(value)}, ${create});`);
    live.depend(live.dependencies(node), `${update}();`);

    return name;
  }

  /** The call of the component; properties that depend on state are set again by its setter. */
  private callValue(
    node: ast.ElementExpression,
    callee: string,
    params: readonly ComponentParam[],
    live: Live | null,
  ): string {
    const id = this.nextId();
    const base = resultName(node);
    const result = `$$${base}${id}`;
    const attributes = new Map<string, ast.JsxAttribute>();
    const args: string[] = [];
    // The setter takes the properties without `children`, in the same order.
    const settable: string[] = [];
    const sources = new Set<Source>();

    for (const attribute of node.attributes) {
      if (attribute.kind === 'JsxAttribute') attributes.set(attribute.name.name, attribute);
    }

    for (const param of params) {
      if (param.name === 'children') {
        const fragment = `$$children${this.nextId()}`;

        this.line(`const ${fragment} = document.createDocumentFragment();`);
        this.children(fragment, node.children, live);
        args.push(fragment);
        continue;
      }

      const attribute = attributes.get(param.name);
      const text = attribute ? this.valueArgument(attribute, param) : 'undefined';
      const value = attribute?.value;
      const propSources =
        live && value && value.kind !== 'EventHandler' ? live.dependencies(value) : null;

      args.push(text);
      if (value && value.kind !== 'EventHandler' && propSources && propSources.size > 0) {
        for (const source of propSources) sources.add(source);
        settable.push(
          this.nullAsDefault(this.liveExpression(value, BINARY['??'] + 1), value, param),
        );
      } else {
        settable.push(text);
      }
    }

    const call = `${callee}(${withoutTrailingUndefined(args).join(', ')})`;

    if (!live || sources.size === 0) {
      this.line(`const [${result}] = ${call};`);

      return result;
    }

    const setter = `$$set${upperFirst(base)}${id}`;

    this.line(`const [${result}, ${setter}] = ${call};`);
    live.depend(sources, `${setter}(${withoutTrailingUndefined(settable).join(', ')});`);

    return result;
  }

  /** The value of a property: literals and names as they are, other values in a temporary. */
  private valueArgument(attribute: ast.JsxAttribute, param: ComponentParam): string {
    const { value } = attribute;

    if (value === null) return 'true';
    if (value.kind === 'EventHandler') {
      const temp = this.temp();

      this.line(`const ${temp} = ${this.handler(value)};`);

      return temp;
    }

    if (isConstant(value) || isSimple(value)) {
      return this.nullAsDefault(this.expression(value, BINARY['??'] + 1), value, param);
    }

    // A function given to the component runs later, not while the markup is being created.
    const text =
      value.kind === 'ArrowFunction' || value.kind === 'FuncExpression'
        ? this.withRendering(0, () => this.expression(value, ARROW))
        : this.expression(value, ARROW);
    const temp = this.temp();

    this.line(`const ${temp} = ${text};`);

    return this.nullAsDefault(temp, value, param);
  }

  /**
   * A property of type `?T` may belong to one with a default value, which null must give: so null
   * is passed as undefined, the value that takes the default.
   */
  private nullAsDefault(text: string, value: ast.Expression, param: ComponentParam): string {
    if (!isNullable(param.type)) return text;
    if (value.kind === 'NullLiteral') return 'undefined';

    const type = this.typeOf(value);

    return !type || type.kind === 'any' || type.kind === 'unknown' || isNullable(type)
      ? `${text} ?? undefined`
      : text;
  }
}

/** `$$sectionContent3` for `<section.content />`, `$$page3` for `<Page />`. */
function resultName(node: ast.ElementExpression): string {
  const parts = (node.tag?.name ?? 'component').split('.');

  return parts.map((part, i) => (i === 0 ? lowerFirst(part) : upperFirst(part))).join('');
}
