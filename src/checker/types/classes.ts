import { createClass, func, nullable, property } from './constructors.ts';
import { ANY, STRING, type ClassInfo, type FunctionType, type Member, type Type } from './model.ts';

// Classes: the built-in Error, inheritance and members.

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
export function publicMembers(type: Type): Map<string, Member> | null {
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
