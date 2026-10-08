import { instanceMembers } from './classes.ts';
import { arrayOf, func, nonNull, nullable, union } from './constructors.ts';
import { instantiate } from './generics.ts';
import { memberNames } from './lazy.ts';
import {
  VOID,
  type FunctionType,
  type Member,
  type ObjectType,
  type Type,
  type TypeParam,
} from './model.ts';
import { typesEqual } from './relations.ts';

// Type parameters: substituting type arguments and inferring them from the arguments of a call.

/** Whether a type mentions type parameters: any of them, or only those in `only`. */
export function containsTypeParam(
  type: Type,
  only: ReadonlySet<TypeParam> | null = null,
  seen = new Set<Type>(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  const contains = (each: Type) => containsTypeParam(each, only, seen);
  switch (type.kind) {
    case 'param':
      return only === null || only.has(type);
    case 'object':
      if (type.typeParams?.some((param) => only === null || only.has(param))) return true;
      if (type.instanceOf) return type.instanceOf.args.some(contains);
      // A named interface without parameters cannot use them; an object type literal might.
      if (type.name !== null) return false;
      return [...type.members.values()].some((member) => contains(member.type));
    case 'class':
      return (type.args ?? []).some(contains);
    case 'array':
      return contains(type.element);
    case 'nullable':
      return contains(type.type);
    case 'union':
      return type.types.some(contains);
    case 'function':
      return [...type.params, ...type.results].some(contains);
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
    case 'union':
      return union(type.types.map((member) => substitute(member, bindings, fallback)));
    case 'class':
      return type.args
        ? { ...type, args: type.args.map((arg) => substitute(arg, bindings, fallback)) }
        : type;
    case 'object':
      return substituteObject(type, bindings, fallback);
    case 'function': {
      // A generic method of a generic interface keeps its own parameters: `map[U]` of `Box[T]`.
      // A default that uses the interface's parameters needs a parameter of its own:
      // `then[TResult1 = T]` of `Promise[Response]` has the default Response.
      const own = new Map(bindings);
      const typeParams = type.typeParams
        .filter((param) => !bindings.has(param))
        .map((param) => {
          if (!param.default || !containsTypeParam(param.default, new Set(bindings.keys()))) {
            return param;
          }
          const fresh = freshParam(param, substitute(param.default, bindings));
          own.set(param, fresh);
          return fresh;
        });
      const sub = (each: Type) => substitute(each, own, fallback);
      const result = func(type.params.map(sub), type.results.map(sub), {
        required: type.required,
        ...(type.rest ? { rest: sub(type.rest) } : {}),
        typeParams,
      });
      if (type.overloads) {
        result.overloads = type.overloads.map((overload) => sub(overload) as FunctionType);
      }
      return result;
    }
    default:
      return type;
  }
}

const freshParams = new WeakMap<TypeParam, TypeParam[]>();

/** A copy of a type parameter with another default; the same copy for the same default. */
function freshParam(param: TypeParam, fallback: Type): TypeParam {
  let copies = freshParams.get(param);
  if (!copies) {
    copies = [];
    freshParams.set(param, copies);
  }
  let copy = copies.find((each) => each.default && typesEqual(each.default, fallback));
  if (!copy) {
    copy = { ...param, default: fallback };
    copies.push(copy);
  }
  return copy;
}

function substituteObject(
  type: ObjectType,
  bindings: Map<TypeParam, Type>,
  fallback?: Type,
): ObjectType {
  const sub = (each: Type) => substitute(each, bindings, fallback);
  if (type.typeParams && type.typeParams.length > 0) {
    return instantiate(type, type.typeParams.map(sub));
  }
  if (type.instanceOf) {
    return instantiate(type.instanceOf.template, type.instanceOf.args.map(sub));
  }
  // A named interface without parameters cannot use them; an object type literal might.
  if (type.name !== null || !containsTypeParam(type)) return type;
  const members = new Map<string, Member>();
  for (const [name, member] of type.members)
    members.set(name, { ...member, type: sub(member.type) });
  return { ...type, members, call: type.call && (sub(type.call) as FunctionType) };
}

const MAX_STRUCTURAL_DEPTH = 3;

/** Infers type parameters in `param` from the argument type `arg`. */
export function inferTypeParams(
  param: Type,
  arg: Type,
  bindings: Map<TypeParam, Type>,
  depth = 0,
): void {
  if (!containsTypeParam(param)) return;
  const infer = (p: Type, a: Type) => inferTypeParams(p, a, bindings, depth);
  switch (param.kind) {
    case 'param':
      if (!bindings.has(param) && arg.kind !== 'unknown' && arg.kind !== 'never') {
        bindings.set(param, arg);
      }
      break;
    case 'array':
      if (arg.kind === 'array') infer(param.element, arg.element);
      break;
    case 'nullable':
      infer(param.type, nonNull(arg));
      break;
    case 'union': {
      // `T | PromiseLike[T]` from `Promise[string]`: a member with structure first, so that T is
      // string, not the whole promise; then a bare parameter.
      const members = param.types.filter((member) => containsTypeParam(member));
      for (const member of members) {
        if (member.kind === 'param') continue;
        const trial = new Map(bindings);
        inferTypeParams(member, arg, trial, depth);
        if (trial.size > bindings.size) {
          for (const [key, value] of trial) bindings.set(key, value);
          return;
        }
      }
      const bare = members.find((member) => member.kind === 'param');
      if (bare) infer(bare, arg);
      break;
    }
    case 'class':
      if (arg.kind === 'class' && arg.info === param.info && param.args && arg.args) {
        param.args.forEach((each, i) => infer(each, arg.args![i]!));
      }
      break;
    case 'object': {
      if (
        param.instanceOf &&
        arg.kind === 'object' &&
        arg.instanceOf?.template === param.instanceOf.template
      ) {
        param.instanceOf.args.forEach((each, i) => infer(each, arg.instanceOf!.args[i]!));
        break;
      }
      // Structurally: `{ value T }` from `{ value number }`. Types refer to themselves, and the
      // methods of generic interfaces give ever new instances (`then` of a promise gives a
      // promise), so only a few levels deep, as in TypeScript.
      if (depth >= MAX_STRUCTURAL_DEPTH) break;
      const members =
        arg.kind === 'object'
          ? arg.members
          : arg.kind === 'class'
            ? instanceMembers(arg.info)
            : null;
      if (!members) break;
      for (const name of memberNames(param.members)) {
        const found = members.get(name);
        const member = found && param.members.get(name);
        if (member) inferTypeParams(member.type, found.type, bindings, depth + 1);
      }
      break;
    }
    case 'function':
      if (arg.kind === 'function') {
        param.params.forEach((p, i) => {
          const a = arg.params[i];
          if (a) infer(p, a);
        });
        // A callback without a result gives void: `then(text => { ... })`.
        if (arg.results.length === 0 && param.results.length === 1) infer(param.results[0]!, VOID);
        param.results.forEach((r, i) => {
          const a = arg.results[i];
          if (a) infer(r, a);
        });
      }
      break;
    default:
      break;
  }
}
