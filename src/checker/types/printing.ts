import { ERROR_CLASS } from './classes.ts';
import { nullable } from './constructors.ts';
import type { Type } from './model.ts';

// Types as text, for messages.

/** How deep object types without a name are printed with their members. */
const MAX_OBJECT_DEPTH = 3;
/** How many members of an object type without a name are printed: `globalThis` has hundreds. */
const MAX_OBJECT_MEMBERS = 8;
let objectDepth = 0;

export function typeToString(type: Type): string {
  switch (type.kind) {
    case 'number':
    case 'string':
    case 'bool':
    case 'any':
    case 'void':
    case 'null':
    case 'never':
    case 'unknown':
      return type.kind;

    case 'array':
      return `[]${grouped(type.element)}`;

    case 'nullable':
      if (type.type === ERROR_CLASS.instance) return 'error';

      return `?${grouped(type.type)}`;

    case 'union':
      return type.name ?? type.types.map(typeToString).join(' | ');

    case 'literal':
      return typeof type.value === 'string' ? JSON.stringify(type.value) : String(type.value);

    case 'function': {
      const params = type.params.map((param, i) =>
        typeToString(i < type.required ? param : nullable(param)),
      );

      if (type.rest) params.push(`...${typeToString(type.rest)}`);

      return `func(${params.join(', ')})${resultsToString(type.results)}`;
    }

    // A property that may be left out is printed as nullable, as it is written in the type.
    case 'component': {
      const params = type.params.map(
        (param) =>
          `${param.name} ${typeToString(param.optional && param.name !== 'children' ? nullable(param.type) : param.type)}`,
      );

      return `comp(${params.join(', ')})`;
    }

    case 'object': {
      // `chan T`, `chan<- T` and `<-chan T` are written with spaces, not as type arguments.
      if (
        type.instanceOf &&
        (type.name === 'chan' || type.name === 'chan<-' || type.name === '<-chan')
      ) {
        return `${type.name} ${typeToString(type.instanceOf.args[0]!)}`;
      }

      if (type.instanceOf && type.name !== null) {
        return `${type.name}<${type.instanceOf.args.map(typeToString).join(', ')}>`;
      }

      if (type.name !== null) return type.name;
      // Types from a `.d.ts` may contain themselves without a name.
      if (objectDepth >= MAX_OBJECT_DEPTH) return '{ ... }';
      objectDepth++;
      try {
        const members = [...type.members]
          .slice(0, MAX_OBJECT_MEMBERS)
          .map(([name, member]) => `${name} ${typeToString(member.type)}`);

        if (type.members.size > MAX_OBJECT_MEMBERS) members.push('...');
        if (type.numberIndex) members.unshift(`[number]: ${typeToString(type.numberIndex)}`);
        if (type.index) members.unshift(`[string]: ${typeToString(type.index)}`);

        return members.length === 0 ? '{}' : `{ ${members.join('; ')} }`;
      } finally {
        objectDepth--;
      }
    }

    case 'class':
      return type.args
        ? `${type.info.name}<${type.args.map(typeToString).join(', ')}>`
        : type.info.name;

    case 'classValue':
      return `class ${type.info.name}`;

    case 'tuple':
      return `(${type.types.map(typeToString).join(', ')})`;

    case 'param':
      return type.name;
  }
}

/** A union without a name needs parentheses after `[]` and `?`: `[](string | number)`. */
function grouped(type: Type): string {
  const text = typeToString(type);

  return type.kind === 'union' && type.name === undefined ? `(${text})` : text;
}

function resultsToString(results: Type[]): string {
  if (results.length === 0) return '';
  if (results.length === 1) return ` ${typeToString(results[0]!)}`;

  return ` (${results.map(typeToString).join(', ')})`;
}
