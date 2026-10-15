import type { ObjectType, Type } from './types.ts';

// What `for ... in` goes over besides arrays, strings and channels: the iterables of the lib files,
// whose values come from `[Symbol.iterator]()`. A Map gives its keys and values, as a map in Go.

/** `Map<K, V>` or `ReadonlyMap<K, V>`: `for key, value in m`, and `for value in m` for the values. */
export function isMap(type: Type): boolean {
  const name = type.kind === 'object' ? (type.instanceOf?.template.name ?? type.name) : null;

  return name === 'Map' || name === 'ReadonlyMap';
}

/** The key and the value of `for key, value in x`: of a Map, or of an array-like with positions. */
export function loopEntry(type: ObjectType): [Type, Type] | null {
  const { iterates, numberIndex, instanceOf } = type;

  if (!iterates) return null;
  if (isMap(type)) return instanceOf ? [instanceOf.args[0]!, instanceOf.args[1]!] : null;

  // A typed array or a NodeList has positions, and `entries()`, as an array has.
  return numberIndex && type.members.has('entries') ? [{ kind: 'number' }, iterates] : null;
}
