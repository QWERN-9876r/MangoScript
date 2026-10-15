import { ANY, func, instantiate, method, VOID, type ObjectType, type Type } from './types.ts';

// Promises: the type of what an async function returns, and what `await` gives.

/**
 * `Promise<T>` where there are no TypeScript lib files (the playground): enough to wait for it
 * and to pass it on. With the lib files, their `Promise` replaces it.
 */
export const PROMISE: ObjectType = {
  kind: 'object',
  name: 'Promise',
  members: new Map([
    ['then', method(func([ANY, ANY], [ANY], { required: 1 }))],
    ['catch', method(func([ANY], [ANY]))],
    ['finally', method(func([ANY], [ANY]))],
  ]),
  call: null,
  typeParams: [{ kind: 'param', name: 'T' }],
};

/** `Promise<T>` of the global `Promise` type, for the results of an async function. */
export function promiseOf(promise: Type | undefined, results: readonly Type[]): Type {
  if (promise?.kind !== 'object' || promise.typeParams?.length !== 1) return ANY;

  const value =
    results.length === 0
      ? VOID
      : results.length === 1
        ? results[0]!
        : { kind: 'tuple' as const, types: [...results] };

  return instantiate(promise, [value]);
}

/** Whether a type is a `Promise<T>` (or a `PromiseLike<T>` from the lib files). */
export function isPromise(type: Type): type is ObjectType {
  return (
    type.kind === 'object' &&
    (type.instanceOf?.template.name === 'Promise' ||
      type.instanceOf?.template.name === 'PromiseLike')
  );
}

/** What `await` gives: the value of a Promise; a value that is not a Promise is itself. */
export function awaited(type: Type): Type {
  return isPromise(type) ? (type.instanceOf!.args[0] ?? ANY) : type;
}

/**
 * The results the body of an async function returns, from the results of its type: none for
 * `Promise<void>`, several for a Promise of a tuple.
 */
export function awaitedResults(results: readonly Type[]): Type[] {
  const [promise] = results;

  if (promise === undefined) return [];

  const value = awaited(promise);

  return value.kind === 'void' ? [] : value.kind === 'tuple' ? value.types : [value];
}
