import { hasZeroValue, instantiate, nullable, type ObjectType, type Type } from './types.ts';

// Channels: `chan T`, made by `chan<T>(size)`, and the channels of one direction, `chan<- T` that
// only sends and `<-chan T` that only receives, as in Go. A channel type is an instance of a
// generic object without members, so that the relations of types handle it; it is written and
// printed by its own syntax, and only a channel of the same values is assignable to it
// (relations.ts).

export type ChanDirection = 'both' | 'send' | 'receive';

function template(name: string): ObjectType {
  return {
    kind: 'object',
    name,
    members: new Map(),
    call: null,
    typeParams: [{ kind: 'param', name: 'T' }],
  };
}

export const CHAN: ObjectType = template('chan');

const TEMPLATES: Readonly<Record<ChanDirection, ObjectType>> = {
  both: CHAN,
  send: template('chan<-'),
  receive: template('<-chan'),
};

export function chanOf(element: Type, direction: ChanDirection = 'both'): ObjectType {
  return instantiate(TEMPLATES[direction], [element]);
}

export function isChan(type: Type): type is ObjectType {
  return type.kind === 'object' && chanDirection(type) !== null;
}

/** Which way a channel type goes, or null for a type that is not a channel. */
export function chanDirection(type: ObjectType): ChanDirection | null {
  const template = type.instanceOf?.template;

  if (template === TEMPLATES.both) return 'both';
  if (template === TEMPLATES.send) return 'send';
  if (template === TEMPLATES.receive) return 'receive';

  return null;
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
