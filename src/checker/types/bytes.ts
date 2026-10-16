import { holdsBigInts } from '../../typed-arrays.ts';
import { func, method, nullable, property } from './constructors.ts';
import { ANY, BIGINT, BOOL, NUMBER, STRING, type ObjectType } from './model.ts';

// `[]byte` is a Uint8Array, as in Go a byte slice, and `[]float64` a Float64Array. With the lib
// files of TypeScript they are their typed arrays; the browser compiler has none, so these list
// what code of typed arrays uses most.

const builtIn = new Map<string, ObjectType>();

/** The built-in typed array of that name, `Float64Array`, for the browser compiler. */
export function builtInTypedArray(name: string): ObjectType {
  const known = builtIn.get(name);

  if (known) return known;

  const element = holdsBigInts(name) ? BIGINT : NUMBER;
  const type: ObjectType = {
    kind: 'object',
    name,
    members: new Map(),
    call: null,
    numberIndex: element,
    iterates: element,
  };
  const same = (params: Parameters<typeof func>[0], required = 0) =>
    method(func(params, [type], { required }));

  builtIn.set(name, type);

  for (const [member, value] of Object.entries({
    length: property(NUMBER),
    byteLength: property(NUMBER),
    at: method(func([NUMBER], [nullable(element)])),
    slice: same([NUMBER, NUMBER]),
    subarray: same([NUMBER, NUMBER]),
    fill: same([element, NUMBER, NUMBER], 1),
    reverse: same([]),
    set: method(func([ANY, NUMBER], [], { required: 1 })),
    indexOf: method(func([element, NUMBER], [NUMBER], { required: 1 })),
    includes: method(func([element, NUMBER], [BOOL], { required: 1 })),
    join: method(func([STRING], [STRING], { required: 0 })),
    forEach: method(func([func([element, NUMBER], [])], [])),
    map: same([func([element, NUMBER], [element])], 1),
    filter: same([func([element, NUMBER], [BOOL])], 1),
    some: method(func([func([element, NUMBER], [BOOL])], [BOOL])),
    every: method(func([func([element, NUMBER], [BOOL])], [BOOL])),
    find: method(func([func([element, NUMBER], [BOOL])], [nullable(element)])),
    findIndex: method(func([func([element, NUMBER], [BOOL])], [NUMBER])),
    reduce: method(func([func([ANY, element, NUMBER], [ANY]), ANY], [ANY], { required: 1 })),
    // Two variables of `for` take positions from `entries()` (iterables.ts).
    entries: method(func([], [ANY])),
  })) {
    type.members.set(member, value);
  }

  return type;
}

export const BYTES: ObjectType = builtInTypedArray('Uint8Array');
