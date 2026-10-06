import type * as ast from '../ast.ts';

// Facts about the JS syntax that the generated code must respect.

// Operator precedence: an operand whose precedence is lower than required gets parentheses.
export const ARROW = 1;
export const CONDITIONAL = 2;
export const UNARY = 14;
export const POSTFIX = 17;
export const PRIMARY = 18;

export const BINARY: Readonly<Record<ast.BinaryOperator, number>> = {
  '??': 3,
  '||': 3,
  '&&': 4,
  '|': 5,
  '^': 6,
  '&': 7,
  '==': 8,
  '!=': 8,
  '<': 9,
  '>': 9,
  '<=': 9,
  '>=': 9,
  instanceof: 9,
  '<<': 10,
  '>>': 10,
  '>>>': 10,
  '+': 11,
  '-': 11,
  '*': 12,
  '/': 12,
  '%': 12,
  '**': 13,
};

/** Names that MangoScript allows but strict-mode JS reserves; they get a `$` suffix. */
export const JS_RESERVED: ReadonlySet<string> = new Set([
  'debugger',
  'delete',
  'do',
  'enum',
  'function',
  'implements',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/** Names that strict-mode JS can read but not declare. */
export const JS_UNDECLARABLE: ReadonlySet<string> = new Set(['eval', 'arguments']);

/** `[a, , c]`; skipped (empty) elements at the end are dropped: `[q, ]` → `[q]`. */
export function arrayPattern(elements: readonly string[]): string {
  let end = elements.length;
  while (end > 0 && elements[end - 1] === '') end--;
  return `[${elements.slice(0, end).join(', ')}]`;
}

/** A statement written at block level goes one level deeper into a function. */
export function indentMore(text: string): string {
  return text.replace(/\n/g, '\n  ');
}

/** `count` → `Count`, for generated names like `$$updateCount3`. */
export function upperFirst(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}
