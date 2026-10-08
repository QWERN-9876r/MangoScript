import { instanceMembers, isSubclass, publicMembers } from './classes.ts';
import { isNullable, literalBase, nonNull, union } from './constructors.ts';
import { UNKNOWN, VOID, type FunctionType, type Member, type Type } from './model.ts';
import { typeToString } from './printing.ts';

// Relations between types: assignability, comparison, equality, common types.

/** Whether a value of type `source` can be used where `target` is expected. */
export function isAssignable(source: Type, target: Type): boolean {
  return assignable(source, target, []);
}

export function assignable(source: Type, target: Type, assuming: [Type, Type][]): boolean {
  if (source === target) return true;
  if (source.kind === 'any' || source.kind === 'unknown' || source.kind === 'never') return true;
  if (target.kind === 'any' || target.kind === 'unknown') return true;

  if (target.kind === 'nullable') {
    if (source.kind === 'null') return true;
    return assignable(nonNull(source), target.type, assuming);
  }
  if (source.kind === 'nullable' || source.kind === 'null') return false;

  // A union can be used where each of its members can; a union accepts what one member accepts.
  if (source.kind === 'union')
    return source.types.every((type) => assignable(type, target, assuming));
  if (target.kind === 'union')
    return target.types.some((type) => assignable(source, type, assuming));
  if (target.kind === 'literal') return source.kind === 'literal' && source.value === target.value;
  if (source.kind === 'literal') return assignable(literalBase(source), target, assuming);

  // Recursive types (e.g. `next ?Node`): assume the pair matches while checking it.
  if (assuming.some(([s, t]) => s === source && t === target)) return true;
  const nested: [Type, Type][] = [...assuming, [source, target]];

  // Inside a generic function, `T Shape` can be used as a `Shape`.
  if (source.kind === 'param' && source !== target) {
    return source.constraint ? assignable(source.constraint, target, nested) : false;
  }

  switch (target.kind) {
    case 'number':
    case 'string':
    case 'bool':
    case 'void':
      return source.kind === target.kind;
    case 'null':
    case 'never':
    case 'param':
      return false;
    case 'array':
      return source.kind === 'array' && assignable(source.element, target.element, nested);
    case 'tuple':
      return (
        source.kind === 'tuple' &&
        source.types.length === target.types.length &&
        source.types.every((type, i) => assignable(type, target.types[i]!, nested))
      );
    case 'function':
      return source.kind === 'function' && functionAssignable(source, target, nested);
    case 'classValue':
      return source.kind === 'classValue' && isSubclass(source.info, target.info);
    case 'class': {
      if (source.kind === 'class' && source.info === target.info && target.args) {
        return (source.args ?? []).every((arg, i) => assignable(arg, target.args![i]!, nested));
      }
      if (source.kind === 'class' && isSubclass(source.info, target.info)) return true;
      // Private and protected members make a class nominal, as in TypeScript.
      const members = instanceMembers(target.info);
      if ([...members.values()].some((member) => member.visibility !== 'public')) return false;
      return missingMember(source, members, nested) === null;
    }
    case 'object': {
      // A callable interface from a `.d.ts`: `interface Listener { (event: Event): void }`.
      if (target.call) {
        const call =
          source.kind === 'function' ? source : source.kind === 'object' ? source.call : null;
        if (!call || !functionAssignable(call, target.call, nested)) return false;
        if (source.kind === 'function') return target.members.size === 0;
      }
      return missingMember(source, target.members, nested) === null;
    }
  }
}

function functionAssignable(source: FunctionType, target: FunctionType, assuming: [Type, Type][]) {
  if (source.typeParams.length > 0 || target.typeParams.length > 0) return true;
  // A function may ignore parameters it is given, but not require more than it gets.
  if (source.required > target.params.length && target.rest === null) return false;
  const shared = Math.min(source.params.length, target.params.length);
  for (let i = 0; i < shared; i++) {
    if (!assignable(target.params[i]!, source.params[i]!, assuming)) return false;
  }
  // A callback that returns something can be used where nothing is expected.
  if (target.results.length === 0) return true;
  // And one that returns nothing where `void` may be returned, as `TResult | PromiseLike[TResult]`
  // of `then` once TResult is void.
  if (source.results.length === 0 && target.results.length === 1) {
    return assignable(VOID, target.results[0]!, assuming);
  }
  return (
    source.results.length === target.results.length &&
    source.results.every((type, i) => assignable(type, target.results[i]!, assuming))
  );
}

/**
 * The first member of `members` that `source` lacks or has with an incompatible type, or `null`
 * if there is none. Properties with a nullable type may be missing.
 */
function missingMember(
  source: Type,
  members: Map<string, Member>,
  assuming: [Type, Type][],
): { name: string; found: Type | null; expected: Type } | null {
  const own = publicMembers(source);
  if (own === null) return { name: '', found: null, expected: UNKNOWN };
  for (const [name, member] of members) {
    const found = own.get(name);
    if (!found) {
      if (!member.method && isNullable(member.type)) continue;
      return { name, found: null, expected: member.type };
    }
    if (!assignable(found.type, member.type, assuming)) {
      return { name, found: found.type, expected: member.type };
    }
  }
  return null;
}

/** Why `source` is not assignable to an object or class `target`, e.g. `missing field "y"`. */
export function explainMismatch(source: Type, target: Type): string | null {
  // `Stack[number]` and `Stack[string]`: the type arguments already say what differs.
  if (source.kind === 'class' && target.kind === 'class' && source.info === target.info) {
    return null;
  }
  const members =
    target.kind === 'object'
      ? target.members
      : target.kind === 'class'
        ? instanceMembers(target.info)
        : null;
  if (members === null || publicMembers(source) === null) return null;
  const missing = missingMember(source, members, []);
  if (missing === null) return null;
  if (missing.found === null) return `missing "${missing.name}"`;
  return `"${missing.name}" is ${typeToString(missing.found)}, not ${typeToString(missing.expected)}`;
}

/**
 * Can values of these types be compared with `==`? Literals must be able to be equal:
 * `filter == "activ"` is an error when `filter` is `"all" | "active"`.
 */
export function isComparable(a: Type, b: Type): boolean {
  if (a.kind === 'null' || b.kind === 'null') return true;
  const x = nonNull(a);
  const y = nonNull(b);
  if (x.kind === 'union') return x.types.some((type) => isComparable(type, y));
  if (y.kind === 'union') return y.types.some((type) => isComparable(x, type));
  return isAssignable(x, y) || isAssignable(y, x);
}

/** A type that both can be used as, e.g. for array elements: one of them, or their union. */
export function commonType(a: Type, b: Type): Type {
  if (isAssignable(b, a)) return a.kind === 'never' ? b : a;
  if (isAssignable(a, b)) return b;
  return union([a, b]);
}

export function typesEqual(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.kind === 'array' && b.kind === 'array') return typesEqual(a.element, b.element);
  if (a.kind === 'nullable' && b.kind === 'nullable') return typesEqual(a.type, b.type);
  if (a.kind === 'literal' && b.kind === 'literal') return a.value === b.value;
  if (a.kind === 'class' && b.kind === 'class') {
    return (
      a.info === b.info && (a.args ?? []).every((arg, i) => typesEqual(arg, b.args?.[i] ?? arg))
    );
  }
  if (a.kind === 'object' && b.kind === 'object' && a.instanceOf && b.instanceOf) {
    return (
      a.instanceOf.template === b.instanceOf.template &&
      a.instanceOf.args.every((arg, i) => typesEqual(arg, b.instanceOf!.args[i]!))
    );
  }
  if (a.kind === 'union' && b.kind === 'union') {
    return (
      a.types.length === b.types.length &&
      a.types.every((type) => b.types.some((other) => typesEqual(type, other)))
    );
  }
  return false;
}

/** Types that a variable can have without an initial value: `0`, `""`, `false`, `[]`, `null`. */
export function hasZeroValue(type: Type): boolean {
  switch (type.kind) {
    case 'number':
    case 'string':
    case 'bool':
    case 'array':
    case 'nullable':
    case 'null':
    case 'any':
    case 'unknown':
      return true;
    default:
      return false;
  }
}
