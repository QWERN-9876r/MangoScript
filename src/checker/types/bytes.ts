import { func, method, nullable, property } from './constructors.ts';
import { ANY, BOOL, NUMBER, STRING, type ObjectType } from './model.ts';

// `[]byte` is a Uint8Array, as in Go a byte slice. With the lib files of TypeScript it is their
// Uint8Array; the browser compiler has none, so this one lists what byte code uses most.

export const BYTES: ObjectType = {
  kind: 'object',
  name: 'Uint8Array',
  members: new Map(),
  call: null,
  numberIndex: NUMBER,
  iterates: NUMBER,
};

const sameBytes = (params: Parameters<typeof func>[0], required = 0) =>
  method(func(params, [BYTES], { required }));

for (const [name, member] of Object.entries({
  length: property(NUMBER),
  byteLength: property(NUMBER),
  at: method(func([NUMBER], [nullable(NUMBER)])),
  slice: sameBytes([NUMBER, NUMBER]),
  subarray: sameBytes([NUMBER, NUMBER]),
  fill: sameBytes([NUMBER, NUMBER, NUMBER], 1),
  reverse: sameBytes([]),
  set: method(func([ANY, NUMBER], [], { required: 1 })),
  indexOf: method(func([NUMBER, NUMBER], [NUMBER], { required: 1 })),
  includes: method(func([NUMBER, NUMBER], [BOOL], { required: 1 })),
  join: method(func([STRING], [STRING], { required: 0 })),
  forEach: method(func([func([NUMBER, NUMBER], [])], [])),
  map: sameBytes([func([NUMBER, NUMBER], [NUMBER])], 1),
  filter: sameBytes([func([NUMBER, NUMBER], [BOOL])], 1),
  some: method(func([func([NUMBER, NUMBER], [BOOL])], [BOOL])),
  every: method(func([func([NUMBER, NUMBER], [BOOL])], [BOOL])),
  find: method(func([func([NUMBER, NUMBER], [BOOL])], [nullable(NUMBER)])),
  findIndex: method(func([func([NUMBER, NUMBER], [BOOL])], [NUMBER])),
  reduce: method(func([func([ANY, NUMBER, NUMBER], [ANY]), ANY], [ANY], { required: 1 })),
  // Two variables of `for` take positions from `entries()` (iterables.ts).
  entries: method(func([], [ANY])),
})) {
  BYTES.members.set(name, member);
}
