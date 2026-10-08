import type { Visibility } from '../../ast.ts';

// The types the checker works with, after names and aliases are resolved.

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
  | TypeParam
  | UnionType
  | LiteralType;

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
  /** Type parameters inferred from the arguments of each call, e.g. `map` or `func first[T any]`. */
  typeParams: TypeParam[];
  /** The other signatures of an overloaded function from a `.d.ts`; a call uses the first that fits. */
  overloads?: FunctionType[];
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
  /** `new` on a value of this type, as with `declare var Foo: { new(): Foo }` in a `.d.ts`. */
  construct?: FunctionType;
  /** `[key: string]: T` in a `.d.ts`: the type of members that are not listed. */
  index?: Type;
  /** A generic interface, `interface Box[T]`: its members use these parameters. */
  typeParams?: TypeParam[];
  /** `Box[number]`: the generic interface and the type arguments it was made from. */
  instanceOf?: { template: ObjectType; args: Type[] };
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
  /** `class Stack[T]`: members use these parameters, instances give them arguments. */
  typeParams: TypeParam[];
  /** Type arguments for a generic base class: the defaults of a class from a `.d.ts`. */
  superArgs?: Type[];
  ctorVisibility: Visibility;
  instance: ClassType;
  value: ClassValueType;
}

/** An instance of a class; `args` are the type arguments of a generic class: `Stack[number]`. */
export interface ClassType {
  kind: 'class';
  info: ClassInfo;
  args?: Type[];
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
  /** `T Shape`: what the argument must be, and what a value of type `T` can do. */
  constraint?: Type | null;
  /** Used when no argument is given: `T = string` in a `.d.ts`. */
  default?: Type;
}

/**
 * `string | number`: at least two members, none of them nullable, a union or `any` (see `union`).
 * A union that may also be null is wrapped in `NullableType`: `?(string | number)`.
 */
export interface UnionType {
  kind: 'union';
  types: Type[];
  /** The `type` alias it was declared with, for messages: `Filter`. */
  name?: string;
}

/** `"all"`, `42`, `true`: a type with a single value. */
export interface LiteralType {
  kind: 'literal';
  value: string | number | boolean;
}
