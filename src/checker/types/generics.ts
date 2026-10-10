import { LazyMap, memberNames } from './lazy.ts';
import {
  UNKNOWN,
  type ClassInfo,
  type ClassType,
  type FunctionType,
  type Member,
  type ObjectType,
  type Type,
  type TypeParam,
} from './model.ts';
import { substitute } from './params.ts';
import { typesEqual } from './relations.ts';

// Generic interfaces and classes with type arguments.

/** Bindings of type parameters to type arguments. */
export function bindParams(
  params: readonly TypeParam[],
  args: readonly Type[],
): Map<TypeParam, Type> {
  return new Map(params.map((param, i) => [param, args[i] ?? UNKNOWN]));
}

export const instances = new WeakMap<ObjectType, { args: Type[]; instance: ObjectType }[]>();

/**
 * `Box[number]` from `interface Box[T]`. Instances are cached, so that a type that refers to itself
 * (`interface Node[T] { next ?Node[T] }`) gets the same instance back; arguments that are the
 * parameters themselves give the generic interface.
 */
export function instantiate(template: ObjectType, args: readonly Type[]): ObjectType {
  const params = template.typeParams ?? [];

  if (params.every((param, i) => args[i] === param)) return template;

  let cached = instances.get(template);

  if (!cached) {
    cached = [];
    instances.set(template, cached);
  }

  const found = cached.find((entry) => entry.args.every((arg, i) => typesEqual(arg, args[i]!)));

  if (found) return found.instance;

  const bindings = bindParams(params, args);
  // Members are substituted when they are used: a template from a `.d.ts` may still be filling
  // its own members, and large interfaces are mostly not used whole.
  const instance: ObjectType = {
    kind: 'object',
    name: template.name,
    members: new LazyMap(
      () => memberNames(template.members),
      (name) => {
        const member = template.members.get(name);

        return member && { ...member, type: substitute(member.type, bindings) };
      },
    ),
    call: template.call && (substitute(template.call, bindings) as FunctionType),
    instanceOf: { template, args: [...args] },
  };

  if (template.construct) {
    instance.construct = substitute(template.construct, bindings) as FunctionType;
  }

  cached.push({ args: [...args], instance });

  return instance;
}

/** An instance of a class with type arguments; a class without parameters has one instance. */
export function classInstance(info: ClassInfo, args: readonly Type[]): ClassType {
  return info.typeParams.length === 0 ? info.instance : { kind: 'class', info, args: [...args] };
}

/**
 * The type of a member as seen on an instance: `Stack[number].items` is `[]number`. A member of a
 * generic base class gets the arguments that the subclass gives it.
 */
export function memberTypeOf(object: Type, member: Member): Type {
  if (object.kind !== 'class' || !member.owner) return member.type;

  let info = object.info;
  let bindings = bindParams(info.typeParams, object.args ?? info.typeParams);

  while (info !== member.owner && info.superClass) {
    const args = (info.superArgs ?? []).map((arg) => substitute(arg, bindings));

    info = info.superClass;
    bindings = bindParams(info.typeParams, args.length > 0 ? args : info.typeParams);
  }

  return substitute(member.type, bindings);
}
