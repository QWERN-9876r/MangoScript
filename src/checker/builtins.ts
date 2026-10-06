import { DOM_TYPES, EVENT } from './dom.ts';
import {
  ANY,
  arrayOf,
  BOOL,
  ERROR,
  ERROR_CLASS,
  func,
  method,
  NUMBER,
  nullable,
  property,
  STRING,
  type FunctionType,
  type Member,
  type ObjectType,
  type Type,
  type TypeParam,
} from './types.ts';

// Types of the JS standard library that MangoScript programs use most. Anything not listed here
// can still be reached through the untyped globals below.

function object(name: string, members: Record<string, Member>, call?: FunctionType): ObjectType {
  return { kind: 'object', name, members: new Map(Object.entries(members)), call: call ?? null };
}

const numberToNumber = method(func([NUMBER], [NUMBER]));

export function stringMember(name: string): Member | undefined {
  switch (name) {
    case 'length':
      return property(NUMBER);
    case 'at':
      return method(func([NUMBER], [nullable(STRING)]));
    case 'charAt':
      return method(func([NUMBER], [STRING]));
    case 'charCodeAt':
      return method(func([NUMBER], [NUMBER]));
    case 'codePointAt':
      return method(func([NUMBER], [nullable(NUMBER)]));
    case 'indexOf':
    case 'lastIndexOf':
      return method(func([STRING, NUMBER], [NUMBER], { required: 1 }));
    case 'includes':
    case 'startsWith':
    case 'endsWith':
      return method(func([STRING, NUMBER], [BOOL], { required: 1 }));
    case 'slice':
    case 'substring':
      return method(func([NUMBER, NUMBER], [STRING], { required: 0 }));
    case 'toUpperCase':
    case 'toLowerCase':
    case 'trim':
    case 'trimStart':
    case 'trimEnd':
    case 'normalize':
    case 'toString':
      return method(func([], [STRING]));
    case 'split':
      return method(func([ANY, NUMBER], [arrayOf(STRING)], { required: 0 }));
    case 'replace':
    case 'replaceAll':
      return method(func([ANY, ANY], [STRING]));
    case 'repeat':
      return method(func([NUMBER], [STRING]));
    case 'padStart':
    case 'padEnd':
      return method(func([NUMBER, STRING], [STRING], { required: 1 }));
    case 'concat':
      return method(func([], [STRING], { rest: STRING }));
    case 'localeCompare':
      return method(func([STRING], [NUMBER]));
    case 'match':
      return method(func([ANY], [ANY]));
    default:
      return undefined;
  }
}

export function numberMember(name: string): Member | undefined {
  switch (name) {
    case 'toFixed':
    case 'toPrecision':
    case 'toString':
      return method(func([NUMBER], [STRING], { required: 0 }));
    case 'toLocaleString':
      return method(func([], [STRING]));
    default:
      return undefined;
  }
}

export function boolMember(name: string): Member | undefined {
  return name === 'toString' ? method(func([], [STRING])) : undefined;
}

export function arrayMember(element: Type, name: string): Member | undefined {
  const array = arrayOf(element);
  const U: TypeParam = { kind: 'param', name: 'U' };
  /** `func(value T, index number) R`; callbacks may declare fewer parameters. */
  const callback = (result: Type) => func([element, NUMBER], [result]);
  switch (name) {
    case 'length':
      return property(NUMBER);
    case 'push':
    case 'unshift':
      return method(func([], [NUMBER], { rest: element }));
    case 'pop':
    case 'shift':
      return method(func([], [nullable(element)]));
    case 'at':
      return method(func([NUMBER], [nullable(element)]));
    case 'indexOf':
    case 'lastIndexOf':
      return method(func([element], [NUMBER]));
    case 'includes':
      return method(func([element], [BOOL]));
    case 'join':
      return method(func([STRING], [STRING], { required: 0 }));
    case 'slice':
      return method(func([NUMBER, NUMBER], [array], { required: 0 }));
    case 'splice':
      return method(func([NUMBER, NUMBER], [array], { required: 1, rest: element }));
    case 'concat':
      return method(func([], [array], { rest: array }));
    case 'reverse':
      return method(func([], [array]));
    case 'fill':
      return method(func([element], [array]));
    case 'sort':
      return method(func([func([element, element], [NUMBER])], [array], { required: 0 }));
    case 'map':
      return method(func([callback(U)], [arrayOf(U)], { typeParams: [U] }));
    case 'flatMap':
      return method(func([callback(arrayOf(U))], [arrayOf(U)], { typeParams: [U] }));
    case 'filter':
      return method(func([callback(BOOL)], [array]));
    case 'find':
    case 'findLast':
      return method(func([callback(BOOL)], [nullable(element)]));
    case 'findIndex':
    case 'findLastIndex':
      return method(func([callback(BOOL)], [NUMBER]));
    case 'some':
    case 'every':
      return method(func([callback(BOOL)], [BOOL]));
    case 'forEach':
      return method(func([func([element, NUMBER], [])], []));
    case 'reduce':
      return method(func([func([U, element, NUMBER], [U]), U], [U], { typeParams: [U] }));
    case 'entries':
    case 'keys':
    case 'values':
      return method(func([], [ANY]));
    case 'toString':
      return method(func([], [STRING]));
    default:
      return undefined;
  }
}

const log = method(func([], [], { rest: ANY }));

const console = object('console', {
  log,
  error: log,
  warn: log,
  info: log,
  debug: log,
});

const math = object('Math', {
  PI: property(NUMBER),
  E: property(NUMBER),
  LN2: property(NUMBER),
  LN10: property(NUMBER),
  SQRT2: property(NUMBER),
  abs: numberToNumber,
  floor: numberToNumber,
  ceil: numberToNumber,
  round: numberToNumber,
  trunc: numberToNumber,
  sign: numberToNumber,
  sqrt: numberToNumber,
  cbrt: numberToNumber,
  exp: numberToNumber,
  log: numberToNumber,
  log2: numberToNumber,
  log10: numberToNumber,
  sin: numberToNumber,
  cos: numberToNumber,
  tan: numberToNumber,
  asin: numberToNumber,
  acos: numberToNumber,
  atan: numberToNumber,
  pow: method(func([NUMBER, NUMBER], [NUMBER])),
  atan2: method(func([NUMBER, NUMBER], [NUMBER])),
  min: method(func([], [NUMBER], { rest: NUMBER })),
  max: method(func([], [NUMBER], { rest: NUMBER })),
  hypot: method(func([], [NUMBER], { rest: NUMBER })),
  random: method(func([], [NUMBER])),
});

const json = object('JSON', {
  parse: method(func([STRING], [ANY])),
  stringify: method(func([ANY], [STRING], { rest: ANY })),
});

const numberObject = object(
  'Number',
  {
    isNaN: method(func([ANY], [BOOL])),
    isInteger: method(func([ANY], [BOOL])),
    isFinite: method(func([ANY], [BOOL])),
    isSafeInteger: method(func([ANY], [BOOL])),
    parseFloat: method(func([STRING], [NUMBER])),
    parseInt: method(func([STRING, NUMBER], [NUMBER], { required: 1 })),
    MAX_SAFE_INTEGER: property(NUMBER),
    MIN_SAFE_INTEGER: property(NUMBER),
    MAX_VALUE: property(NUMBER),
    MIN_VALUE: property(NUMBER),
    EPSILON: property(NUMBER),
    POSITIVE_INFINITY: property(NUMBER),
    NEGATIVE_INFINITY: property(NUMBER),
    NaN: property(NUMBER),
  },
  func([ANY], [NUMBER]),
);

const stringObject = object(
  'String',
  { fromCharCode: method(func([], [STRING], { rest: NUMBER })) },
  func([ANY], [STRING]),
);

const booleanObject = object('Boolean', {}, func([ANY], [BOOL]));

const timer = func([func([], []), NUMBER], [ANY], { required: 1, rest: ANY });

/** JS globals that are available without types: everything about them is `any`. */
const UNTYPED_GLOBALS = [
  'Object',
  'Array',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Symbol',
  'BigInt',
  'Reflect',
  'Proxy',
  'Intl',
  'globalThis',
  'process',
  'Buffer',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'fetch',
  'structuredClone',
  'queueMicrotask',
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'crypto',
  'performance',
];

export const GLOBAL_VALUES: ReadonlyMap<string, Type> = new Map<string, Type>([
  ['console', console],
  ['Math', math],
  ['JSON', json],
  ['Number', numberObject],
  ['String', stringObject],
  ['Boolean', booleanObject],
  ['parseInt', func([STRING, NUMBER], [NUMBER], { required: 1 })],
  ['parseFloat', func([STRING], [NUMBER])],
  ['isNaN', func([NUMBER], [BOOL])],
  ['isFinite', func([NUMBER], [BOOL])],
  ...['encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI'].map(
    (name): [string, Type] => [name, func([STRING], [STRING])],
  ),
  ['setTimeout', timer],
  ['setInterval', timer],
  ['clearTimeout', func([ANY], [])],
  ['clearInterval', func([ANY], [])],
  ['NaN', NUMBER],
  ['Infinity', NUMBER],
  ['Error', ERROR_CLASS.value],
  // `error("message")` creates an Error, so the result is never null.
  ['error', func([STRING], [ERROR_CLASS.instance])],
  ...UNTYPED_GLOBALS.map((name): [string, Type] => [name, ANY]),
]);

export const GLOBAL_TYPES: ReadonlyMap<string, Type> = new Map<string, Type>([
  ['number', NUMBER],
  ['string', STRING],
  ['bool', BOOL],
  ['any', ANY],
  ['error', ERROR],
  ['Error', ERROR_CLASS.instance],
  ...['Date', 'RegExp', 'Map', 'Set', 'Promise', 'URL'].map((name): [string, Type] => [name, ANY]),
  ...DOM_TYPES,
  ['Event', EVENT],
]);
