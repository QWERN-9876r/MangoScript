import type * as ast from '../ast.ts';
import { attributeName, htmlTagName, RESERVED_PROPERTIES, tagNameProblem } from '../html-tag.ts';
import { endlessRecursion } from '../recursion.ts';
import type { ComponentInfo } from './context.ts';
import { CONTENT } from './dom.ts';
import { lookupIn, ownStatements, freeNames, isUntyped, callSignature } from './helpers.ts';
import { MarkupChecker } from './markup.ts';
import {
  BOOL,
  func,
  hasZeroValue,
  isAssignable,
  isNullable,
  nonNull,
  spreadFields,
  STRING,
  typesEqual,
  typeToString,
  UNKNOWN,
  type Type,
} from './types.ts';

// Components: their bodies and uses, properties and spread, names they use from the module, recursion.

export abstract class ComponentChecker extends MarkupChecker {
  protected override resolveProps(info: ComponentInfo): void {
    for (const param of info.node.params) {
      const name = param.name.name;
      const type = param.type ? this.resolveType(param.type) : UNKNOWN;
      if (name === 'children' && type !== CONTENT && type.kind !== 'unknown') {
        this.error('the "children" property has the type Content', param.type ?? param);
      }
      if (info.props.has(name)) this.error(`duplicate property "${name}"`, param.name);
      const optional = param.defaultValue !== null || isNullable(type) || name === 'children';
      info.props.set(name, { type, optional });
    }
  }

  /** The body runs once where the component is used and must end with `return <markup>`. */
  protected override checkComponentBody(info: ComponentInfo): void {
    const { node } = info;
    const last = node.body.body.at(-1);
    if (last?.kind !== 'ReturnStatement' || last.values.length !== 1) {
      this.error('a component ends with "return <markup>"', {
        start: node.body.end - 1,
        end: node.body.end,
      });
    }
    for (const statement of ownStatements(node.body)) {
      if (statement.kind === 'DeferStatement') {
        this.error('defer is not supported in components yet', statement);
      }
    }

    const types: Type[] = [];
    for (const param of node.params) {
      const prop = info.props.get(param.name.name);
      const type = prop?.type ?? UNKNOWN;
      types.push(type);
      if (param.defaultValue) {
        const value = this.checkValue(param.defaultValue, type);
        this.expectAssignable(value, type, param.defaultValue);
      }
    }

    const saved = this.component;
    this.component = info;
    try {
      this.withClass(null, () =>
        this.checkFunction(node.params, func(types, []), null, node.body, {
          paramKind: 'prop',
          isComponent: true,
        }),
      );
    } finally {
      this.component = saved;
    }
  }

  /** `<Card title="Profile">...</Card>`: properties are checked like the arguments of a call. */
  protected override checkComponentUse(node: ast.ElementExpression, tag: ast.Identifier): Type {
    const binding = this.lookupValue(tag.name);
    const info = binding?.component;
    if (!info) {
      this.error(
        binding ? `"${tag.name}" is not a component` : `unknown component <${tag.name}>`,
        tag,
      );
      return UNKNOWN;
    }
    // The code of a function component is not inlined here.
    if (!info.isFunction) this.checkHygiene(info, tag);

    const given = new Set<string>();
    const spread = new Set<string>();
    for (const attribute of node.attributes) {
      if (attribute.kind === 'JsxSpreadAttribute') {
        this.checkSpreadProps(attribute.argument, info, tag.name, spread);
        continue;
      }
      const name = attribute.name.name;
      const prop = info.props.get(name);
      if (given.has(name)) this.error(`duplicate property "${name}"`, attribute.name);
      given.add(name);
      if (name === 'children' && prop) {
        this.error(
          `pass children between the tags: <${tag.name}>...</${tag.name}>`,
          attribute.name,
        );
      } else if (!prop) {
        this.error(`<${tag.name}> has no property "${name}"`, attribute.name);
      } else {
        this.checkProp(attribute, prop.type, tag.name);
      }
    }
    for (const [name, prop] of info.props) {
      if (!prop.optional && !given.has(name) && !spread.has(name)) {
        this.error(`<${tag.name}> needs the property "${name}"`, tag);
      }
    }
    if (node.children.length > 0 && !info.props.has('children')) {
      this.error(`<${tag.name}> takes no children`, node.children[0]!);
    }
    this.checkChildren(node.children);
    return this.componentResult(info, new Set());
  }

  /**
   * `<Product {...product} />`: fields of the object with the names of properties are passed as
   * those properties; other fields are ignored. Adds the names of the given properties to `given`.
   */
  protected checkSpreadProps(
    argument: ast.Expression,
    info: ComponentInfo,
    component: string,
    given: Set<string>,
  ): void {
    const type = this.checkValue(argument);
    if (isUntyped(type)) {
      for (const name of info.props.keys()) given.add(name);
      return;
    }
    const fields = isNullable(type) ? null : spreadFields(type);
    if (!fields) {
      if (isNullable(type)) this.nullError(argument);
      else {
        this.error(
          `cannot spread ${typeToString(type)} into the properties of <${component}>`,
          argument,
        );
      }
      // After the error, missing properties would only repeat it.
      for (const name of info.props.keys()) given.add(name);
      return;
    }
    for (const [name, prop] of info.props) {
      const field = fields.get(name);
      if (field === undefined || name === 'children') continue;
      given.add(name);
      this.expectAssignable(field, prop.type, argument, ` for "${name}" of <${component}>`);
    }
  }

  protected override checkProp(attribute: ast.JsxAttribute, type: Type, component: string): void {
    const name = attribute.name.name;
    const { value } = attribute;
    if (value?.kind === 'EventHandler') {
      // Code for a callback property; `event` is the callback's first argument, if it has one.
      const signature = callSignature(nonNull(type));
      if (!signature && !isUntyped(type)) {
        this.error(`"${name}" of <${component}> is not a function, so it needs a value`, value);
        return;
      }
      this.checkEventHandler(value, signature?.params[0] ?? null);
      return;
    }
    const valueType =
      value === null
        ? BOOL
        : value.kind === 'StringLiteral'
          ? STRING
          : this.checkValue(value, type);
    this.expectAssignable(valueType, type, value ?? attribute, ` for "${name}" of <${component}>`);
  }

  /**
   * The component's code is inlined where it is used, so the names of the module that it uses
   * must not be hidden there by local declarations.
   */
  protected checkHygiene(info: ComponentInfo, tag: ast.Identifier): void {
    info.freeNames ??= freeNames(info.node);
    for (const name of info.freeNames) {
      if (this.lookupValue(name) !== lookupIn(this.moduleScope, name)) {
        this.error(
          `<${tag.name}> uses "${name}" of the module, but here "${name}" is another declaration: rename one of them`,
          tag,
        );
        return;
      }
    }
  }

  /** The type of `<Card />`: what its markup creates. */
  protected componentResult(info: ComponentInfo, seen: Set<ComponentInfo>): Type {
    seen.add(info);
    // With early returns, the result is what all the returned elements have in common.
    const types = ownStatements(info.node.body)
      .filter((statement) => statement.kind === 'ReturnStatement')
      .map((statement) => this.markupType(statement.values[0], seen));
    const [first] = types;
    if (first === undefined) return this.dom.node;
    if (types.every((type) => typesEqual(type, first))) return first;
    const { element, node } = this.dom;
    return types.every((type) => isAssignable(type, element)) ? element : node;
  }

  /** The type of the markup a component returns, found without checking it again. */
  protected markupType(value: ast.Expression | undefined, seen: Set<ComponentInfo>): Type {
    if (value?.kind !== 'ElementExpression') return this.dom.node;
    if (value.tag === null) return this.dom.fragment;
    if (!/^[A-Z]/.test(value.tag.name)) return this.elementOf(value.tag.name);
    const other = lookupIn(this.moduleScope, value.tag.name)?.component;
    if (!other || seen.has(other)) return this.dom.node;
    return this.componentResult(other, new Set(seen));
  }

  /**
   * A component may use itself, but some use on the cycle must be under a condition (if, for, a
   * branch of `?:`...), or creating the component never ends.
   */
  protected checkEndlessRecursion(): void {
    const components = new Map<string, ast.ComponentDeclaration>();
    for (const statement of this.program.body) {
      if (statement.kind === 'ComponentDeclaration') components.set(statement.name.name, statement);
    }
    for (const { cycle, tag } of endlessRecursion(components)) {
      this.error(
        `endless recursion: ${cycle.join(' → ')} always creates itself again; put the use inside if or for`,
        tag,
      );
    }
  }

  /** `@html-tag` components: valid and different tags, and properties HTMLElement does not have. */
  protected checkHtmlTags(): void {
    const tags = new Map<string, ast.ComponentDeclaration>();
    for (const statement of this.program.body) {
      if (statement.kind !== 'ComponentDeclaration' || !statement.htmlTag) continue;
      const tag = htmlTagName(statement);
      const given = statement.htmlTag.name;
      const problem = tagNameProblem(tag);
      const other = tags.get(tag);
      if (problem) {
        this.error(
          given
            ? `"${tag}" is not a valid name of a web component: ${problem}`
            : `the tag of "${statement.name.name}" would be "${tag}", not a valid name of a web component: ${problem}; give one, e.g. @html-tag("app-${tag}")`,
          given ?? statement.htmlTag,
        );
      } else if (other) {
        this.error(
          `the tag "${tag}" is already used by ${other.name.name}`,
          given ?? statement.htmlTag,
        );
      }
      tags.set(tag, statement);
      const info = this.moduleScope.values.get(statement.name.name)?.component;
      for (const param of statement.params) {
        const name = param.name.name;
        const type = info?.props.get(name)?.type;
        if (RESERVED_PROPERTIES.has(name)) {
          this.error(
            `a web component cannot have the property "${name}": HTMLElement has it already`,
            param.name,
          );
        } else if (name !== 'children' && !param.defaultValue && type && !hasZeroValue(type)) {
          // `<app-card>` in HTML has no properties until they are set.
          this.error(
            `"${name}" needs a default value: the element can be created without it, e.g. in HTML, and ${typeToString(type)} has no zero value`,
            param.name,
          );
        }
      }
    }
  }

  /** The type of a property of a web component of this module, by its tag and an attribute. */
  protected override webComponentProperty(tag: string, attribute: string): Type | null {
    for (const statement of this.program.body) {
      if (statement.kind !== 'ComponentDeclaration' || !statement.htmlTag) continue;
      if (htmlTagName(statement) !== tag) continue;
      const info = this.moduleScope.values.get(statement.name.name)?.component;
      if (!info) return null;
      for (const [name, prop] of info.props) {
        if (name !== 'children' && (name === attribute || attributeName(name) === attribute)) {
          return prop.type;
        }
      }
      return null;
    }
    return null;
  }
}
