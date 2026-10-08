import type * as ast from '../ast.ts';
import type { Type } from '../checker/types.ts';
import { forEachChild } from '../walk.ts';

// What code reads and what may change values: which methods mutate, which only read.

/** Array methods that change the array. */
const ARRAY_MUTATORS: ReadonlySet<string> = new Set([
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

/** The variable at the start of `a.b[i].c()`, or `null`. */
export function rootName(node: ast.Expression): string | null {
  switch (node.kind) {
    case 'Identifier':
      return node.name;
    case 'MemberExpression':
    case 'IndexExpression':
      return rootName(node.object);
    case 'CallExpression':
      return rootName(node.callee);
    default:
      return null;
  }
}

/** Names whose values a node reads, not counting code that runs on events. */
export function readNames(node: ast.Node, names: Set<string>): void {
  switch (node.kind) {
    case 'Identifier':
      names.add(node.name);
      return;
    case 'MemberExpression':
      readNames(node.object, names);
      return;
    case 'Property':
      readNames(node.value, names);
      return;
    case 'ElementExpression':
      for (const attribute of node.attributes) readNames(attribute, names);
      for (const child of node.children) readNames(child, names);
      return;
    case 'JsxAttribute':
      if (node.value !== null && !/^on[A-Z]/.test(node.name.name)) readNames(node.value, names);
      return;
    // Both run later, when the markup exists.
    case 'EventHandler':
    case 'MountStatement':
      return;
    default:
      forEachChild(node, (child) => readNames(child, names));
  }
}
