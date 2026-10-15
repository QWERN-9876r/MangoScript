import type * as ast from '../ast.ts';
import { ChannelChecker } from './channels.ts';
import {
  ARRAY_MEMBERS,
  ATTRIBUTE_NAMES,
  BOOL_MEMBERS,
  EVENT_ATTRIBUTES,
  HTML_TAGS,
  NUMBER_MEMBERS,
  STRING_MEMBERS,
} from './completion-names.ts';
import type { Binding, Completion, CompletionContext, CompletionResult, Scope } from './context.ts';
import {
  isSubclass,
  literalBase,
  memberNames,
  memberTypeOf,
  nonNull,
  typeToString,
  union,
  UNKNOWN,
  type ClassInfo,
  type Member,
  type Type,
} from './types.ts';

// Completion in editors (src/completion.ts): the editor writes the name `options.completion` where
// the cursor is, and this layer lists what can be written there when the check reaches that name:
// the names in scope, the members of the value before a dot, the types, the tags of markup or the
// attributes of an element. The name itself is not an error: the check goes on as if it were
// `unknown`.

const PRIMITIVE_MEMBERS = { string: STRING_MEMBERS, number: NUMBER_MEMBERS, bool: BOOL_MEMBERS };

export abstract class CompletionChecker extends ChannelChecker {
  protected completion: CompletionResult | null = null;

  private atCursor(node: ast.Identifier): boolean {
    return node.name === this.options.completion;
  }

  /** The first check of the cursor counts: a component's body, for one, is checked for each use. */
  private complete(context: CompletionContext, items: () => Completion[]): void {
    this.completion ??= { context, items: items() };
  }

  protected override checkIdentifier(node: ast.Identifier): Type {
    if (!this.atCursor(node)) return super.checkIdentifier(node);
    this.complete('value', () => this.valueNames());

    return UNKNOWN;
  }

  protected override checkChain(
    node: ast.MemberExpression | ast.IndexExpression | ast.CallExpression,
    expected: Type | null = null,
  ): [Type, boolean] {
    if (node.kind !== 'MemberExpression' || !this.atCursor(node.property)) {
      return super.checkChain(node, expected);
    }

    const [object] =
      node.object.kind === 'SuperExpression'
        ? [this.superType(node.object)]
        : this.chainPart(node.object);

    this.complete('member', () =>
      [...this.membersOf(nonNull(object))].map(([name, member]) => ({
        name,
        kind: member.method ? 'method' : 'property',
        detail: typeToString(member.type),
      })),
    );

    return [UNKNOWN, false];
  }

  protected override resolveTypeName(
    name: ast.Identifier,
    typeArgs: readonly ast.TypeNode[] = [],
  ): Type {
    if (!this.atCursor(name)) return super.resolveTypeName(name, typeArgs);
    this.complete('type', () => this.typeNames());

    return UNKNOWN;
  }

  protected override checkElement(node: ast.ElementExpression): Type {
    const { tag } = node;

    if (tag && this.atCursor(tag)) {
      this.complete('tag', () => this.tagNames());

      return UNKNOWN;
    }

    const cursor = node.attributes.some(
      (attribute) => attribute.kind === 'JsxAttribute' && this.atCursor(attribute.name),
    );

    if (tag && cursor) this.complete('attribute', () => this.attributeNames(node, tag.name));

    return super.checkElement(node);
  }

  // ─── Lists ─────────────────────────────────────────────────────────────────────────────────────

  private valueNames(): Completion[] {
    const found = new Map<string, Completion>();

    // An inner declaration hides an outer one with the same name.
    for (const scope of this.scopes()) {
      for (const binding of scope.values.values()) {
        if (!found.has(binding.name)) found.set(binding.name, this.bindingCompletion(binding));
      }
    }

    for (const name of this.options.library?.names?.('value') ?? []) {
      if (!found.has(name)) found.set(name, { name, kind: 'variable' });
    }

    return [...found.values()];
  }

  private bindingCompletion(binding: Binding): Completion {
    const { name, kind, component } = binding;

    if (component) {
      return { name, kind: 'component', detail: typeToString(this.componentValue(component)) };
    }

    const type = binding.type && (this.flow.get(binding) ?? binding.type);
    const detail = type ? { detail: typeToString(type) } : {};

    if (kind === 'function' || type?.kind === 'function')
      return { name, kind: 'function', ...detail };
    if (kind === 'class' || type?.kind === 'classValue') return { name, kind: 'class', ...detail };

    return { name, kind: kind === 'const' ? 'constant' : 'variable', ...detail };
  }

  private typeNames(): Completion[] {
    const found = new Map<string, Completion>();

    for (const scope of this.scopes()) {
      for (const [name, entry] of scope.types) {
        if (!found.has(name)) {
          found.set(name, { name, kind: entry.kind === 'class' ? 'class' : 'type' });
        }
      }
    }

    for (const name of this.options.library?.names?.('type') ?? []) {
      if (!found.has(name)) found.set(name, { name, kind: 'type' });
    }

    return [...found.values()];
  }

  private tagNames(): Completion[] {
    const components = [...this.scopes()].flatMap((scope) =>
      [...scope.values.values()].flatMap((binding) =>
        binding.component ? [this.bindingCompletion(binding)] : [],
      ),
    );
    const tags = this.options.library?.names?.('tag') ?? HTML_TAGS;

    return [...components, ...[...tags].map((name): Completion => ({ name, kind: 'tag' }))];
  }

  /** Properties of a component, or attributes and events of an element, not given yet. */
  private attributeNames(node: ast.ElementExpression, tag: string): Completion[] {
    const given = new Set(
      node.attributes.flatMap((attribute) =>
        attribute.kind === 'JsxAttribute' ? [attribute.name.name] : [],
      ),
    );
    const items: Completion[] = [{ name: 'ref', kind: 'attribute' }];

    if (/^[A-Z]/.test(tag)) {
      const info = this.lookupValue(tag)?.component;

      if (!info) return [];
      this.resolveProps(info);
      for (const [name, prop] of info.props) {
        if (name !== 'children') {
          items.push({ name, kind: 'property', detail: typeToString(prop.type) });
        }
      }
    } else {
      for (const [property, member] of this.membersOf(this.elementOf(tag))) {
        // Members like `onclick` from TypeScript's lib are events, which are written `onClick`.
        if (member.method || member.type.kind === 'function' || property.startsWith('on')) continue;

        const name = ATTRIBUTE_NAMES.get(property) ?? property;

        items.push({ name, kind: 'attribute', detail: typeToString(member.type) });
      }

      for (const name of EVENT_ATTRIBUTES) items.push({ name, kind: 'attribute' });
    }

    return items.filter((item) => !given.has(item.name));
  }

  // ─── Members ───────────────────────────────────────────────────────────────────────────────────

  /** The members of a value of type `type` that the code here may use. */
  private membersOf(type: Type): Map<string, Member> {
    const members = new Map<string, Member>();
    const add = (names: Iterable<string>, find: (name: string) => Member | 'any' | undefined) => {
      for (const name of names) {
        const member = members.has(name) ? undefined : find(name);

        if (member && member !== 'any') members.set(name, member);
      }
    };

    switch (type.kind) {
      case 'literal':
        return this.membersOf(literalBase(type));

      case 'param':
        return type.constraint ? this.membersOf(type.constraint) : members;

      case 'string':
      case 'number':
      case 'bool': {
        const library = this.options.library?.primitive(type.kind);

        add(PRIMITIVE_MEMBERS[type.kind], (name) => this.memberOf(type, name));
        if (library?.kind === 'object')
          add(memberNames(library.members), (name) => this.memberOf(type, name));
        break;
      }

      case 'array': {
        const library = this.options.library?.array(type.element);
        const find = (name: string) => this.arrayMemberOf(type.element, name);

        add(ARRAY_MEMBERS, find);
        if (library?.kind === 'object') add(memberNames(library.members), find);
        break;
      }

      case 'object':
        add(memberNames(type.members), (name) => type.members.get(name));
        break;

      case 'class':
      case 'classValue':
        for (let info: ClassInfo | null = type.info; info; info = info.superClass) {
          this.ensureClassResolved(info);
          for (const [name, member] of type.kind === 'class' ? info.members : info.statics) {
            if (members.has(name) || !this.canUse(member)) continue;
            members.set(
              name,
              type.kind === 'class' && type.args
                ? { ...member, type: memberTypeOf(type, member) }
                : member,
            );
          }
        }

        break;

      // The members that every type of the union has.
      case 'union': {
        const [first, ...rest] = type.types.map((each) => this.membersOf(each));

        for (const [name, member] of first ?? []) {
          const others = rest.map((each) => each.get(name));

          if (others.some((other) => other === undefined)) continue;

          const all = [member, ...(others as Member[])];

          members.set(name, {
            ...member,
            type: union(all.map((each) => each.type)),
            method: all.every((each) => each.method),
          });
        }

        break;
      }

      default:
        break;
    }

    return members;
  }

  /** Whether the code here may use a member: private and protected ones only in their classes. */
  private canUse({ owner, visibility }: Member): boolean {
    if (!owner || visibility === 'public') return true;

    const current = this.cls?.info;

    return visibility === 'private'
      ? current === owner
      : current !== undefined && isSubclass(current, owner);
  }

  private *scopes(): Generator<Scope> {
    for (let scope: Scope | null = this.scope; scope; scope = scope.parent) yield scope;
  }
}
