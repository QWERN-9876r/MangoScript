import type { Visibility } from '../ast.ts';

/** Types as the checker sees them, after names and aliases have been resolved. */
export type Type =
  | SimpleType
  | ArrayType
  | NullableType
  | FunctionType
  | ObjectType
  | ClassType
  | ClassValueType
  | TupleType
  | TypeParam;

export interface SimpleType {
  kind: 'number' | 'string' | 'bool' | 'any' | 'void' | 'null' | 'never' | 'unknown';
}

export const NUMBER: SimpleType = { kind: 'number' };
export const STRING: SimpleType = { kind: 'string' };
export const BOOL: SimpleType = { kind: 'bool' };
/** Values from JS: anything goes, nothing is checked. */
export const ANY: SimpleType = { kind: 'any' };
/** What a call to a function without results gives. */
export const VOID: SimpleType = { kind: 'void' };
/** The type of the `null` literal. */
export const NULL: SimpleType = { kind: 'null' };
/** Element type of an empty array literal: assignable to every type. */
export const NEVER: SimpleType = { kind: 'never' };
/** The type of an expression that already has an error: accepted everywhere to avoid follow-up errors. */
export const UNKNOWN: SimpleType = { kind: 'unknown' };

export interface ArrayType {
  kind: 'array';
  element: Type;
}

/** `?T`; the inner type itself is never nullable. */
export interface NullableType {
  kind: 'nullable';
  type: Type;
}

export interface FunctionType {
  kind: 'function';
  params: Type[];
  /** How many parameters must be passed; the others may be left out (builtins only). */
  required: number;
  /** Element type of a trailing `...rest` parameter (builtins only). */
  rest: Type | null;
  results: Type[];
  /** Type parameters inferred from the arguments of each call (builtins only, e.g. `map`). */
  typeParams: TypeParam[];
}

export interface Member {
  type: Type;
  method: boolean;
  visibility: Visibility;
  /** The class that declares the member, for visibility checks. */
  owner: ClassInfo | null;
}

/** Interfaces, object type literals and the types of object literals. */
export interface ObjectType {
  kind: 'object';
  name: string | null;
  members: Map<string, Member>;
  /** For callable builtins like `Number(x)`. */
  call: FunctionType | null;
}

export interface ClassInfo {
  name: string;
  superClass: ClassInfo | null;
  /** Extends a JS class whose members are unknown. */
  untypedBase: boolean;
  /** Own instance members; inherited ones are found through `superClass`. */
  members: Map<string, Member>;
  statics: Map<string, Member>;
  /** Own constructor; `null` means it is inherited (or empty). */
  ctor: FunctionType | null;
  ctorVisibility: Visibility;
  instance: ClassType;
  value: ClassValueType;
}

/** An instance of a class. */
export interface ClassType {
  kind: 'class';
  info: ClassInfo;
}

/** The class itself: its constructor and static members. */
export interface ClassValueType {
  kind: 'classValue';
  info: ClassInfo;
}

/** Several results of a call; only allowed where they are unpacked into variables. */
export interface TupleType {
  kind: 'tuple';
  types: Type[];
}

export interface TypeParam {
  kind: 'param';
  name: string;
}

// ─── Constructors ────────────────────────────────────────────────────────────────────────────────

export function arrayOf(element: Type): ArrayType {
  return { kind: 'array', element };
}

export function nullable(type: Type): Type {
  switch (type.kind) {
    case 'nullable':
    case 'null':
    case 'any':
    case 'unknown':
      return type;
    default:
      return { kind: 'nullable', type };
  }
}

export function nonNull(type: Type): Type {
  if (type.kind === 'nullable') return type.type;
  return type.kind === 'null' ? NEVER : type;
}

export function isNullable(type: Type): boolean {
  return type.kind === 'nullable' || type.kind === 'null';
}

export function func(
  params: Type[],
  results: Type[],
  options: { required?: number; rest?: Type; typeParams?: TypeParam[] } = {},
): FunctionType {
  return {
    kind: 'function',
    params,
    required: options.required ?? params.length,
    rest: options.rest ?? null,
    results,
    typeParams: options.typeParams ?? [],
  };
}

export function property(type: Type, owner: ClassInfo | null = null): Member {
  return { type, method: false, visibility: 'public', owner };
}

export function method(type: FunctionType, owner: ClassInfo | null = null): Member {
  return { type, method: true, visibility: 'public', owner };
}

export function createClass(name: string): ClassInfo {
  const info: ClassInfo = {
    name,
    superClass: null,
    untypedBase: false,
    members: new Map(),
    statics: new Map(),
    ctor: null,
    ctorVisibility: 'public',
    instance: undefined as unknown as ClassType,
    value: undefined as unknown as ClassValueType,
  };
  info.instance = { kind: 'class', info };
  info.value = { kind: 'classValue', info };
  return info;
}

/** JS `Error`. The MangoScript type `error` is `?Error`. */
export const ERROR_CLASS = createClass('Error');
ERROR_CLASS.members.set('message', property(STRING, ERROR_CLASS));
ERROR_CLASS.members.set('name', property(STRING, ERROR_CLASS));
ERROR_CLASS.members.set('stack', property(nullable(STRING), ERROR_CLASS));
ERROR_CLASS.members.set('cause', property(ANY, ERROR_CLASS));
ERROR_CLASS.ctor = func([STRING], [], { required: 0 });

export const ERROR: Type = nullable(ERROR_CLASS.instance);

// ─── Classes ─────────────────────────────────────────────────────────────────────────────────────

export function isSubclass(info: ClassInfo, base: ClassInfo): boolean {
  for (let current: ClassInfo | null = info; current; current = current.superClass) {
    if (current === base) return true;
  }
  return false;
}

/** A member of the class or of one of its base classes. */
export function findClassMember(
  info: ClassInfo,
  name: string,
  isStatic: boolean,
): Member | undefined {
  for (let current: ClassInfo | null = info; current; current = current.superClass) {
    const member = (isStatic ? current.statics : current.members).get(name);
    if (member) return member;
  }
  return undefined;
}

export function hasUntypedBase(info: ClassInfo): boolean {
  for (let current: ClassInfo | null = info; current; current = current.superClass) {
    if (current.untypedBase) return true;
  }
  return false;
}

/** All instance members, including inherited ones. */
export function instanceMembers(info: ClassInfo): Map<string, Member> {
  const chain: ClassInfo[] = [];
  for (let current: ClassInfo | null = info; current; current = current.superClass) {
    chain.unshift(current);
  }
  const members = new Map<string, Member>();
  for (const current of chain)
    for (const [name, member] of current.members) members.set(name, member);
  return members;
}

/**
 * The fields that spreading a value gives (`<Card {...user} />`): public non-method members of an
 * object type or a class instance. `null` for other types.
 */
export function spreadFields(type: Type): Map<string, Type> | null {
  let members: Map<string, Member>;
  if (type.kind === 'object') members = type.members;
  else if (type.kind === 'class') members = instanceMembers(type.info);
  else return null;
  const fields = new Map<string, Type>();
  for (const [name, member] of members) {
    if (!member.method && member.visibility === 'public') fields.set(name, member.type);
  }
  return fields;
}

/** The constructor used by `new`, with the class that declares it. */
export function constructorOf(info: ClassInfo): { type: FunctionType; owner: ClassInfo | null } {
  for (let current: ClassInfo | null = info; current; current = current.superClass) {
    if (current.ctor) return { type: current.ctor, owner: current };
    if (current.untypedBase) return { type: func([], [], { rest: ANY }), owner: null };
  }
  return { type: func([], []), owner: null };
}

/** Members that count for structural typing; non-public members are not visible from outside. */
function publicMembers(type: Type): Map<string, Member> | null {
  switch (type.kind) {
    case 'object':
      return type.members;
    case 'class': {
      const members = new Map<string, Member>();
      for (const [name, member] of instanceMembers(type.info)) {
        if (member.visibility === 'public') members.set(name, member);
      }
      return members;
    }
    default:
      return null;
  }
}

// ─── Relations ───────────────────────────────────────────────────────────────────────────────────

/** Whether a value of type `source` can be used where `target` is expected. */
export function isAssignable(source: Type, target: Type): boolean {
  return assignable(source, target, []);
}

function assignable(source: Type, target: Type, assuming: [Type, Type][]): boolean {
  if (source === target) return true;
  if (source.kind === 'any' || source.kind === 'unknown' || source.kind === 'never') return true;
  if (target.kind === 'any' || target.kind === 'unknown') return true;

  if (target.kind === 'nullable') {
    if (source.kind === 'null') return true;
    return assignable(nonNull(source), target.type, assuming);
  }
  if (source.kind === 'nullable' || source.kind === 'null') return false;

  // Recursive types (e.g. `next ?Node`): assume the pair matches while checking it.
  if (assuming.some(([s, t]) => s === source && t === target)) return true;
  const nested: [Type, Type][] = [...assuming, [source, target]];

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
      if (source.kind === 'class' && isSubclass(source.info, target.info)) return true;
      // Private and protected members make a class nominal, as in TypeScript.
      const members = instanceMembers(target.info);
      if ([...members.values()].some((member) => member.visibility !== 'public')) return false;
      return missingMember(source, members, nested) === null;
    }
    case 'object':
      if (target.call) return false;
      return missingMember(source, target.members, nested) === null;
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

/** Can values of these types be compared with `==`? */
export function isComparable(a: Type, b: Type): boolean {
  if (a.kind === 'null' || b.kind === 'null') return true;
  const x = nonNull(a);
  const y = nonNull(b);
  return isAssignable(x, y) || isAssignable(y, x);
}

/** A type that both can be used as, e.g. for array elements; `null` if there is none. */
export function commonType(a: Type, b: Type): Type | null {
  if (isAssignable(b, a)) return a.kind === 'never' ? b : a;
  if (isAssignable(a, b)) return b;
  if (a.kind === 'null') return nullable(b);
  if (b.kind === 'null') return nullable(a);
  if (isNullable(a) || isNullable(b)) {
    const common = commonType(nonNull(a), nonNull(b));
    return common && nullable(common);
  }
  return null;
}

export function typesEqual(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.kind === 'array' && b.kind === 'array') return typesEqual(a.element, b.element);
  if (a.kind === 'nullable' && b.kind === 'nullable') return typesEqual(a.type, b.type);
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

// ─── Type parameters ─────────────────────────────────────────────────────────────────────────────

export function containsTypeParam(type: Type): boolean {
  switch (type.kind) {
    case 'param':
      return true;
    case 'array':
      return containsTypeParam(type.element);
    case 'nullable':
      return containsTypeParam(type.type);
    case 'function':
      return [...type.params, ...type.results].some(containsTypeParam);
    default:
      return false;
  }
}

/** Replaces inferred type parameters; with `fallback`, also those that were not inferred. */
export function substitute(type: Type, bindings: Map<TypeParam, Type>, fallback?: Type): Type {
  switch (type.kind) {
    case 'param':
      return bindings.get(type) ?? fallback ?? type;
    case 'array':
      return arrayOf(substitute(type.element, bindings, fallback));
    case 'nullable':
      return nullable(substitute(type.type, bindings, fallback));
    case 'function':
      return func(
        type.params.map((param) => substitute(param, bindings, fallback)),
        type.results.map((result) => substitute(result, bindings, fallback)),
        {
          required: type.required,
          ...(type.rest ? { rest: substitute(type.rest, bindings, fallback) } : {}),
        },
      );
    default:
      return type;
  }
}

/** Infers type parameters in `param` from the argument type `arg`. */
export function inferTypeParams(param: Type, arg: Type, bindings: Map<TypeParam, Type>): void {
  switch (param.kind) {
    case 'param':
      if (!bindings.has(param) && arg.kind !== 'unknown' && arg.kind !== 'never') {
        bindings.set(param, arg);
      }
      break;
    case 'array':
      if (arg.kind === 'array') inferTypeParams(param.element, arg.element, bindings);
      break;
    case 'nullable':
      inferTypeParams(param.type, nonNull(arg), bindings);
      break;
    case 'function':
      if (arg.kind === 'function') {
        param.params.forEach((p, i) => {
          const a = arg.params[i];
          if (a) inferTypeParams(p, a, bindings);
        });
        param.results.forEach((r, i) => {
          const a = arg.results[i];
          if (a) inferTypeParams(r, a, bindings);
        });
      }
      break;
    default:
      break;
  }
}

// ─── Printing ────────────────────────────────────────────────────────────────────────────────────

export function typeToString(type: Type): string {
  switch (type.kind) {
    case 'number':
    case 'string':
    case 'bool':
    case 'any':
    case 'void':
    case 'null':
    case 'never':
    case 'unknown':
      return type.kind;
    case 'array':
      return `[]${typeToString(type.element)}`;
    case 'nullable':
      return type.type === ERROR_CLASS.instance ? 'error' : `?${typeToString(type.type)}`;
    case 'function': {
      const params = type.params.map((param, i) =>
        i < type.required ? typeToString(param) : `?${typeToString(param)}`,
      );
      if (type.rest) params.push(`...${typeToString(type.rest)}`);
      return `func(${params.join(', ')})${resultsToString(type.results)}`;
    }
    case 'object': {
      if (type.name !== null) return type.name;
      const members = [...type.members].map(
        ([name, member]) => `${name} ${typeToString(member.type)}`,
      );
      return members.length === 0 ? '{}' : `{ ${members.join('; ')} }`;
    }
    case 'class':
      return type.info.name;
    case 'classValue':
      return `class ${type.info.name}`;
    case 'tuple':
      return `(${type.types.map(typeToString).join(', ')})`;
    case 'param':
      return type.name;
  }
}

function resultsToString(results: Type[]): string {
  if (results.length === 0) return '';
  if (results.length === 1) return ` ${typeToString(results[0]!)}`;
  return ` (${results.map(typeToString).join(', ')})`;
}
