import { CONTENT } from './checker/dom.ts';
import {
  ERROR_CLASS,
  isQueue,
  memberNames,
  queueElement,
  type FunctionType,
  type Member,
  type ObjectType,
  type Type,
} from './checker/types.ts';

// Types of the checker in TypeScript syntax, for declaration files (declarations.ts).

/** A nullable property may be left out of an object: `name?: string | null`. */
export function property(name: string, type: Type): string {
  const optional = type.kind === 'nullable' || type.kind === 'null' ? '?' : '';

  return `${name}${optional}: ${tsType(type)};`;
}

export function resultType(results: readonly Type[]): string {
  if (results.length === 0) return 'void';
  if (results.length === 1) return tsType(results[0]!);

  return `[${results.map((result) => tsType(result)).join(', ')}]`;
}

/**
 * A type in TypeScript syntax. A union keeps the name of its alias, except in the alias itself
 * (`expand`).
 */
export function tsType(type: Type, expand = false): string {
  switch (type.kind) {
    case 'number':
    case 'bigint':
    case 'string':
    case 'any':
    case 'void':
    case 'null':
    case 'never':
    case 'unknown':
      return type.kind;

    case 'bool':
      return 'boolean';

    case 'literal':
      return typeof type.value === 'string' ? JSON.stringify(type.value) : String(type.value);

    case 'nullable':
      return `${grouped(type.type)} | null`;

    case 'union':
      if (type.name !== undefined && !expand) return type.name;

      return type.types.map(grouped).join(' | ');

    case 'array':
      return `${element(type.element)}[]`;

    case 'tuple':
      return `[${type.types.map((each) => tsType(each)).join(', ')}]`;

    case 'function':
      return functionType(type);

    // The function of the component: it returns the node and a function that sets the properties.
    case 'component': {
      const params = type.params.map(
        (param) => `${param.name}${param.optional ? '?' : ''}: ${tsType(param.type)}`,
      );

      return `(${params.join(', ')}) => [Node, ...unknown[]]`;
    }

    case 'object':
      return objectType(type);

    case 'class': {
      if (type.info === ERROR_CLASS) return 'Error';

      const args = type.args ? `<${type.args.map((arg) => tsType(arg)).join(', ')}>` : '';

      return `${type.info.name}${args}`;
    }

    case 'classValue':
      return `typeof ${type.info.name}`;

    case 'param':
      return type.name;
  }
}

function functionType(type: FunctionType): string {
  if (type.iterator) return `() => ${generatorType(type)}`;

  return `(${anonymousParameters(type)}) => ${resultType(type.results)}`;
}

/** What calling an iterator gives: a generator of what its `yield` takes, a value or a pair. */
export function generatorType(iterator: FunctionType): string {
  const yieldType = iterator.params[0];
  const taken = yieldType?.kind === 'function' ? yieldType.params : [];
  const yielded =
    taken.length === 1 ? tsType(taken[0]!) : `[${taken.map((each) => tsType(each)).join(', ')}]`;

  return `Generator<${yielded}, void, unknown>`;
}

/** A method of an object type: `name(arg1: number): string`. */
function methodType(name: string, type: FunctionType): string {
  return `${name}(${anonymousParameters(type)}): ${resultType(type.results)};`;
}

/** Parameters of a function type, which has no names for them. */
function anonymousParameters(type: FunctionType): string {
  const params = type.params.map(
    (param, i) => `arg${i + 1}${i < type.required ? '' : '?'}: ${tsType(param)}`,
  );

  if (type.rest) params.push(`...rest: ${element(type.rest)}[]`);

  return params.join(', ');
}

function objectType(type: ObjectType): string {
  // The children of a component are a fragment at runtime.
  if (type === CONTENT) return 'Node';
  // A channel is an object with its id; TypeScript code only passes it on.
  if (type.name === 'chan' || type.name === 'chan<-' || type.name === '<-chan') {
    return `{ readonly $$chan: string }`;
  }

  // A queue is an instance of a class of the module (queue-helpers.ts): TypeScript code uses its
  // members.
  if (isQueue(type)) {
    const value = queueElement(type);
    const items = `...items: ${element(value)}[]`;
    const end = value.kind === 'nullable' ? tsType(value) : `${grouped(value)} | null`;

    return `{ readonly length: number; push(${items}): number; unshift(${items}): number; shift(): ${end}; pop(): ${end}; at(index: number): ${end}; clear(): void; [Symbol.iterator](): Iterator<${tsType(value)}> }`;
  }

  if (type.name !== null) {
    const args = type.instanceOf?.args ?? type.typeParams;

    return args ? `${type.name}<${args.map((arg) => tsType(arg)).join(', ')}>` : type.name;
  }

  const members = [...memberNames(type.members)].map((name) => {
    const member: Member | undefined = type.members.get(name);

    if (!member) return '';
    if (member.method && member.type.kind === 'function') return methodType(name, member.type);

    return property(name, member.type);
  });

  if (type.call) members.push(methodType('', type.call));
  if (type.index) members.unshift(`[key: string]: ${tsType(type.index)};`);

  return members.length === 0 ? '{}' : `{ ${members.filter(Boolean).join(' ')} }`;
}

/** Parentheses around unions and functions inside `| null`: `(string | number) | null`. */
function grouped(type: Type): string {
  const text = tsType(type);

  return type.kind === 'function' ||
    type.kind === 'component' ||
    (type.kind === 'union' && type.name === undefined)
    ? `(${text})`
    : text;
}

/** An element type before `[]`: `(string | null)[]`. */
function element(type: Type): string {
  const text = tsType(type);

  return type.kind === 'function' ||
    type.kind === 'component' ||
    type.kind === 'nullable' ||
    (type.kind === 'union' && type.name === undefined)
    ? `(${text})`
    : text;
}
