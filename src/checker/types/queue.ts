import { func, method, nullable, property } from './constructors.ts';
import { instantiate } from './generics.ts';
import { NUMBER, type ObjectType, type Type, type TypeParam } from './model.ts';

// `queue T`, made by `queue<T>()`: values that go in and out at both ends without moving the
// others, as an array moves them on `shift()`. A queue type is an instance of a generic object
// with the members of an array that a queue keeps, and only a queue is assignable to it
// (relations.ts). The template is made on first use, since the modules of types import each other.

let template: ObjectType | null = null;

function queueTemplate(): ObjectType {
  if (template) return template;

  const T: TypeParam = { kind: 'param', name: 'T' };

  template = {
    kind: 'object',
    name: 'queue',
    members: new Map([
      ['length', property(NUMBER)],
      ['push', method(func([], [NUMBER], { rest: T }))],
      ['unshift', method(func([], [NUMBER], { rest: T }))],
      // An empty queue gives null, as `pop()` of an empty array gives undefined.
      ['shift', method(func([], [nullable(T)]))],
      ['pop', method(func([], [nullable(T)]))],
      ['at', method(func([NUMBER], [nullable(T)]))],
      ['clear', method(func([], []))],
    ]),
    call: null,
    iterates: T,
    typeParams: [T],
  };

  return template;
}

export function queueOf(element: Type): ObjectType {
  return instantiate(queueTemplate(), [element]);
}

/** Whether a type is `queue T`. */
export function isQueue(type: Type): boolean {
  return type.kind === 'object' && template !== null && type.instanceOf?.template === template;
}

/** The type of the values of a queue type. */
export function queueElement(queue: Type): Type {
  return (queue as ObjectType).instanceOf!.args[0]!;
}
