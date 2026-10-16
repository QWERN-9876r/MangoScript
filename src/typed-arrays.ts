// Typed arrays, written as slices of Go: `[]float64` is a Float64Array, as `[]byte` is a
// Uint8Array. The names of the elements are numbers, and bigints for the integers of 64 bits.

/** The typed array of each element type of Go. */
export const TYPED_ELEMENTS: ReadonlyMap<string, string> = new Map([
  ['byte', 'Uint8Array'],
  ['uint8', 'Uint8Array'],
  ['int8', 'Int8Array'],
  ['int16', 'Int16Array'],
  ['uint16', 'Uint16Array'],
  ['int32', 'Int32Array'],
  ['uint32', 'Uint32Array'],
  ['float32', 'Float32Array'],
  ['float64', 'Float64Array'],
  ['int64', 'BigInt64Array'],
  ['uint64', 'BigUint64Array'],
]);

/** The typed arrays, by the size of an element in bytes. */
export const TYPED_ARRAYS: ReadonlyMap<string, number> = new Map([
  ['Int8Array', 1],
  ['Uint8Array', 1],
  ['Uint8ClampedArray', 1],
  ['Int16Array', 2],
  ['Uint16Array', 2],
  ['Int32Array', 4],
  ['Uint32Array', 4],
  ['Float32Array', 4],
  ['Float64Array', 8],
  ['BigInt64Array', 8],
  ['BigUint64Array', 8],
]);

/** Whether the elements of a typed array are bigints. */
export function holdsBigInts(name: string): boolean {
  return name === 'BigInt64Array' || name === 'BigUint64Array';
}

/** How a typed array is written: `[]float64`, or its own name if Go has none (Uint8ClampedArray). */
export function typedArrayName(name: string): string {
  if (name === 'Uint8Array') return '[]byte';

  for (const [element, array] of TYPED_ELEMENTS) if (array === name) return `[]${element}`;

  return name;
}
