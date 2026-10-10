import type { Type } from './checker/types.ts';

// Which methods change the value they are called on and which only read it. The generator updates
// markup after changes; the checker forbids changes of values that are read-only.

/** Array methods that change the array. */
export const ARRAY_MUTATORS: ReadonlySet<string> = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

/** Methods known to only read, for values that are not arrays or whose type is not known. */
const READ_METHODS: ReadonlySet<string> = new Set([
  'at',
  'charAt',
  'concat',
  'endsWith',
  'entries',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'getTime',
  'includes',
  'indexOf',
  'join',
  'keys',
  'lastIndexOf',
  'map',
  'padEnd',
  'padStart',
  'reduce',
  'reduceRight',
  'repeat',
  'replace',
  'replaceAll',
  'slice',
  'some',
  'split',
  'startsWith',
  'substring',
  'toFixed',
  'toISOString',
  'toLocaleDateString',
  'toLocaleString',
  'toLocaleTimeString',
  'toLowerCase',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
  'valueOf',
  'values',
  'with',
]);

/** Whether calling `method` may change a value of this type. */
export function mayChange(type: Type | undefined, method: string): boolean {
  const known = type?.kind === 'nullable' ? type.type : type;

  switch (known?.kind) {
    case 'string':
    case 'number':
    case 'bool':
      return false;

    case 'array':
      return ARRAY_MUTATORS.has(method);

    default:
      return ARRAY_MUTATORS.has(method) || !READ_METHODS.has(method);
  }
}
