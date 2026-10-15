import { memberNames, typeToString, type Type } from './types.ts';

// What can go to a worker and back: a worker gets a copy of each value (the structured clone of
// postMessage), and a copy has the data of a value but not its methods.

/** Built-in types whose copies are whole: their type arguments are checked, not their members. */
const COPIED = new Set([
  'Map',
  'Set',
  'Date',
  'RegExp',
  'ArrayBuffer',
  'DataView',
  'Blob',
  'File',
  'ImageData',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

/** Why a value of the type cannot be copied to a worker, or null if it can. */
export function notCopied(type: Type, seen = new Set<Type>()): string | null {
  if (seen.has(type)) return null;
  seen.add(type);

  const inner = (types: readonly Type[]) => {
    for (const each of types) {
      const reason = notCopied(each, seen);

      if (reason !== null) return reason;
    }

    return null;
  };

  switch (type.kind) {
    case 'nullable':
      return inner([type.type]);

    case 'array':
      return inner([type.element]);

    case 'tuple':
    case 'union':
      return inner(type.types);

    case 'function':
      return 'a function cannot be copied';

    case 'component':
      return 'a component cannot be copied';

    case 'classValue':
      return `the class ${type.info.name} cannot be copied`;

    case 'class':
      return type.info.name === 'Error'
        ? null
        : `a copy of ${typeToString(type)} would lose its class and methods`;

    case 'object': {
      const name = type.instanceOf?.template.name ?? type.name;

      if (name !== null && COPIED.has(name)) return inner(type.instanceOf?.args ?? []);
      if (type.call || type.construct)
        return `${typeToString(type)} is a function and cannot be copied`;

      const members = [...memberNames(type.members)].flatMap(
        (name) => type.members.get(name) ?? [],
      );

      if (members.some((member) => member.method)) {
        return `a copy of ${typeToString(type)} would lose its methods`;
      }

      return inner(members.map((member) => member.type));
    }

    default:
      return null;
  }
}
