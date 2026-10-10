import {
  BOOL,
  NEVER,
  NULL,
  NUMBER,
  STRING,
  type ArrayType,
  type ClassInfo,
  type ClassType,
  type ClassValueType,
  type FunctionType,
  type LiteralType,
  type Member,
  type Type,
  type TypeParam,
} from './model.ts';
import { typesEqual } from './relations.ts';

// Making types: arrays, nullable types, literals, unions, functions, members, classes.

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

export function literal(value: string | number | boolean): LiteralType {
  return { kind: 'literal', value };
}

/** The type that a literal belongs to: `"all"` → `string`. */
export function literalBase(type: LiteralType): Type {
  return typeof type.value === 'string' ? STRING : typeof type.value === 'number' ? NUMBER : BOOL;
}

/**
 * A union of types, simplified: nested unions are flattened, repeats and `never` are dropped, a
 * literal goes into its base type when that is a member (`"a" | string` → `string`), `true | false`
 * is `bool`, `any` absorbs everything, and `null` makes the union nullable.
 */
export function union(types: readonly Type[]): Type {
  let hasNull = false;
  const members: Type[] = [];
  const add = (type: Type): void => {
    switch (type.kind) {
      case 'union':
        type.types.forEach(add);

        return;

      case 'nullable':
        hasNull = true;
        add(type.type);

        return;

      case 'null':
        hasNull = true;

        return;

      case 'never':
        return;

      default:
        if (!members.some((member) => typesEqual(member, type))) members.push(type);
    }
  };

  types.forEach(add);

  const special = members.find((member) => member.kind === 'any' || member.kind === 'unknown');

  if (special) return special;
  if (
    members.some((m) => m.kind === 'literal' && m.value === true) &&
    members.some((m) => m.kind === 'literal' && m.value === false)
  ) {
    members.push(BOOL);
  }

  const kept = members.filter(
    (member) =>
      member.kind !== 'literal' ||
      !members.some((other) => other.kind === literalBase(member).kind),
  );
  const result: Type =
    kept.length === 0
      ? hasNull
        ? NULL
        : NEVER
      : kept.length === 1
        ? kept[0]!
        : { kind: 'union', types: kept };

  return hasNull ? nullable(result) : result;
}

/** The type a variable gets from a value: literals become their base types, `"a" | "b"` → `string`. */
export function widenLiterals(type: Type): Type {
  switch (type.kind) {
    case 'literal':
      return literalBase(type);

    case 'union':
      return union(type.types.map(widenLiterals));

    case 'nullable':
      return nullable(widenLiterals(type.type));

    default:
      return type;
  }
}

/** The members of a union, or the type itself. */
export function unionMembers(type: Type): readonly Type[] {
  return type.kind === 'union' ? type.types : [type];
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
    typeParams: [],
    ctorVisibility: 'public',
    instance: undefined as unknown as ClassType,
    value: undefined as unknown as ClassValueType,
  };

  info.instance = { kind: 'class', info };
  info.value = { kind: 'classValue', info };

  return info;
}
