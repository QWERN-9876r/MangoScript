import { ERROR_CLASS } from './classes.ts';
import { nullable } from './constructors.ts';
import type { Type } from './model.ts';

// Types as text, for messages.

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

    case 'object': {
      if (type.instanceOf && type.name !== null) {
        return `${type.name}[${type.instanceOf.args.map(typeToString).join(', ')}]`;
      }

      if (type.name !== null) return type.name;

      const members = [...type.members].map(
        ([name, member]) => `${name} ${typeToString(member.type)}`,
      );

      return members.length === 0 ? '{}' : `{ ${members.join('; ')} }`;
    }

    case 'class':
      return type.args
        ? `${type.info.name}[${type.args.map(typeToString).join(', ')}]`
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
