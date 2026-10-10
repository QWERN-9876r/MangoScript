import type * as ast from '../ast.ts';
import { boolMember, numberMember, stringMember } from './builtins.ts';
import { DecoratorMemberChecker } from './decorator-members.ts';
import { isUntyped, isNumeric } from './helpers.ts';
import {
  ANY,
  findClassMember,
  hasUntypedBase,
  isComparable,
  isNullable,
  isSubclass,
  literalBase,
  memberTypeOf,
  nonNull,
  NUMBER,
  property,
  STRING,
  typeToString,
  union,
  UNKNOWN,
  type Member,
  type Type,
} from './types.ts';

// Member access and indexing, with `?.` chains.

export abstract class MemberChecker extends DecoratorMemberChecker {
  /**
   * Member access, indexing and calls. Returns the type and whether an optional link (`?.`)
   * may short-circuit the chain: `a?.b.c()` is null as a whole when `a` is null.
   */
  /** `expected` is for the result of a call: it can give type arguments, as in `let xs []number = empty()`. */
  protected override checkChain(
    node: ast.MemberExpression | ast.IndexExpression | ast.CallExpression,
    expected: Type | null = null,
  ): [Type, boolean] {
    if (node.kind === 'CallExpression') {
      if (node.callee.kind === 'SuperExpression') return [this.checkSuperCall(node), false];

      let [callee, shortCircuits] = this.chainPart(node.callee);

      this.checkDecoratorMutation(node);
      if (isNullable(callee)) {
        if (node.optional) shortCircuits = true;
        else this.nullError(node.callee);
        callee = nonNull(callee);
      }

      return [this.checkCall(node, callee, expected), shortCircuits];
    }

    if (node.kind === 'MemberExpression' && this.decoratorWithoutAt(node)) return [UNKNOWN, false];

    let [object, shortCircuits] =
      node.object.kind === 'SuperExpression'
        ? [this.superType(node.object), false]
        : this.chainPart(node.object);

    if (isNullable(object)) {
      if (node.optional) shortCircuits = true;
      else this.nullError(node.object);
      object = nonNull(object);
    }

    if (node.kind === 'MemberExpression') {
      const member = this.findMember(object, node.property.name, node.property);

      return [member === 'any' ? ANY : (member?.type ?? UNKNOWN), shortCircuits];
    }

    const keyed = this.keyedIndex(object, node.index);

    if (keyed) return [keyed, shortCircuits];
    this.expectIndex(node.index);
    if (object.kind === 'array') return [object.element, shortCircuits];
    if (object.kind === 'string') return [STRING, shortCircuits];
    this.error(`cannot index ${typeToString(object)}`, node);

    return [UNKNOWN, shortCircuits];
  }

  protected chainPart(node: ast.Expression): [Type, boolean] {
    if (
      node.kind === 'MemberExpression' ||
      node.kind === 'IndexExpression' ||
      node.kind === 'CallExpression'
    ) {
      const [type, shortCircuits] = this.checkChain(node);

      return [this.single(type, node), shortCircuits];
    }

    return [this.checkValue(node), false];
  }

  /** The value of an object that must not be null, e.g. before a member assignment. */
  protected override nonNullValue(node: ast.Expression): Type {
    const [type] = this.chainPart(node);

    if (isNullable(type)) this.nullError(node);

    return nonNull(type);
  }

  /**
   * `object[key]` with a key that is not a position: on an untyped value (`data[name]`), or on
   * an object with `[key: string]: T` from a `.d.ts`. `null` for arrays and strings.
   */
  protected override keyedIndex(object: Type, index: ast.Expression): Type | null {
    const type = isUntyped(object) ? object : object.kind === 'object' ? object.index : undefined;

    if (!type) return null;

    const key = this.checkValue(index);

    if (!isUntyped(key) && !isComparable(key, STRING) && !isNumeric(key)) {
      this.error(`a key must be a string or a number, not ${typeToString(key)}`, index);
    }

    return type;
  }

  protected override expectIndex(node: ast.Expression): void {
    const type = this.checkValue(node, NUMBER);

    if (!isNumeric(type)) this.error(`index must be a number, not ${typeToString(type)}`, node);
  }

  /** The member `name` of a value of type `object`; `'any'` for untyped values. */
  protected override findMember(
    object: Type,
    name: string,
    node: ast.NodeBase,
  ): Member | 'any' | undefined {
    let member: Member | undefined;

    switch (object.kind) {
      case 'any':
      case 'unknown':
      case 'never':
        return 'any';

      case 'literal':
        return this.findMember(literalBase(object), name, node);

      case 'param':
        // A value of a type parameter has the members of its constraint.
        if (object.constraint) return this.findMember(object.constraint, name, node);
        this.error(
          `${object.name} has no member "${name}": give the type parameter a constraint, e.g. [${object.name} Shape]`,
          node,
        );

        return undefined;

      case 'union': {
        // A member of a union is one that every type in it has.
        const found = object.types.map((type) => this.memberOf(type, name));

        if (found.includes('any')) return 'any';

        const members = found.filter((each): each is Member => each !== undefined);

        if (members.length < found.length) {
          this.error(
            `${typeToString(object)} has no member "${name}" in every type: narrow it with typeof or instanceof`,
            node,
          );

          return undefined;
        }

        return {
          type: union(members.map((each) => each.type)),
          method: members.every((each) => each.method),
          visibility: 'public',
          owner: null,
        };
      }

      case 'number':
        member = numberMember(name) ?? this.primitiveMember('number', name);
        break;

      case 'string':
        member = stringMember(name) ?? this.primitiveMember('string', name);
        break;

      case 'bool':
        member = boolMember(name) ?? this.primitiveMember('bool', name);
        break;

      case 'array':
        member = this.arrayMemberOf(object.element, name);
        break;

      case 'object':
        member = object.members.get(name) ?? (object.index && property(object.index));
        break;

      case 'class':
        this.ensureClassResolved(object.info);
        member = findClassMember(object.info, name, false);
        if (!member && hasUntypedBase(object.info)) return 'any';
        if (member && object.args) member = { ...member, type: memberTypeOf(object, member) };
        break;

      case 'classValue':
        this.ensureClassResolved(object.info);
        member = findClassMember(object.info, name, true);
        if (!member && hasUntypedBase(object.info)) return 'any';
        break;

      default:
        break;
    }

    if (!member) {
      this.error(`${typeToString(object)} has no member "${name}"`, node);

      return undefined;
    }

    const { owner, visibility } = member;

    if (owner && visibility !== 'public') {
      const current = this.cls?.info;
      const allowed =
        visibility === 'private'
          ? current === owner
          : current !== undefined && isSubclass(current, owner);

      if (!allowed) this.error(`"${name}" is ${visibility} in ${owner.name}`, node);
    }

    return member;
  }

  /** The public member `name` of a type, without reporting anything; for members of unions. */
  protected memberOf(type: Type, name: string): Member | 'any' | undefined {
    switch (type.kind) {
      case 'any':
      case 'unknown':
      case 'never':
        return 'any';

      case 'literal':
        return this.memberOf(literalBase(type), name);

      case 'param':
        return type.constraint ? this.memberOf(type.constraint, name) : undefined;

      case 'number':
        return numberMember(name) ?? this.primitiveMember('number', name);

      case 'string':
        return stringMember(name) ?? this.primitiveMember('string', name);

      case 'bool':
        return boolMember(name) ?? this.primitiveMember('bool', name);

      case 'array':
        return this.arrayMemberOf(type.element, name);

      case 'object':
        return type.members.get(name) ?? (type.index && property(type.index));

      case 'class': {
        this.ensureClassResolved(type.info);

        const member = findClassMember(type.info, name, false);

        if (!member && hasUntypedBase(type.info)) return 'any';
        if (member?.visibility !== 'public') return undefined;

        return type.args ? { ...member, type: memberTypeOf(type, member) } : member;
      }

      default:
        return undefined;
    }
  }
}
