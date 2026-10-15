import { hasZeroValue, instantiate, nullable, type ObjectType, type Type } from './types.ts';

// Channels: `chan T`, made by `chan<T>(size)`. A channel type is an instance of a generic object
// without members, so that the relations of types handle it; `chan T` is written and printed by
// its own syntax, and only the same `chan T` is assignable to it (relations.ts).

export const CHAN: ObjectType = {
  kind: 'object',
  name: 'chan',
  members: new Map(),
  call: null,
  typeParams: [{ kind: 'param', name: 'T' }],
};

export function chanOf(element: Type): ObjectType {
  return instantiate(CHAN, [element]);
}

export function isChan(type: Type): type is ObjectType {
  return type.kind === 'object' && type.instanceOf?.template === CHAN;
}

/** The type of the values of a channel type. */
export function elementOf(chan: ObjectType): Type {
  return chan.instanceOf!.args[0]!;
}

/**
 * What `<-ch` gives: the value, or after `close` the zero value of its type, as in Go. A type
 * without a zero value (an interface, a class) gives null then.
 */
export function received(element: Type): Type {
  return hasZeroValue(element) ? element : nullable(element);
}
