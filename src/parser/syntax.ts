import type * as ast from '../ast.ts';
import type { StringToken, Token, TokenKind } from '../lexer/token.ts';

// Tables and small functions of the parser: operators and their precedence, keywords, the parsing context.

/** Binary operators and their precedence (higher binds tighter), as in JS. */
export const BINARY_PRECEDENCE: Readonly<Record<ast.BinaryOperator, number>> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '|': 4,
  '^': 5,
  '&': 6,
  '==': 7,
  '!=': 7,
  '<': 8,
  '>': 8,
  '<=': 8,
  '>=': 8,
  instanceof: 8,
  '<<': 9,
  '>>': 9,
  '>>>': 9,
  '+': 10,
  '-': 10,
  '*': 11,
  '/': 11,
  '%': 11,
  '**': 12,
};

export const UNARY_OPERATORS: ReadonlySet<string> = new Set<ast.UnaryOperator>([
  '!',
  '-',
  '+',
  '~',
  'typeof',
]);

export const ASSIGNMENT_OPERATORS: ReadonlySet<string> = new Set<ast.AssignmentOperator>([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '&=',
  '|=',
  '^=',
  '<<=',
  '>>=',
  '>>>=',
  '&&=',
  '||=',
  '??=',
]);

export function isBinaryOperator(kind: TokenKind): kind is ast.BinaryOperator {
  return Object.hasOwn(BINARY_PRECEDENCE, kind);
}

export function isUnaryOperator(kind: TokenKind): kind is ast.UnaryOperator {
  return UNARY_OPERATORS.has(kind);
}

export function isAssignmentOperator(kind: TokenKind): kind is ast.AssignmentOperator {
  return ASSIGNMENT_OPERATORS.has(kind);
}

export const RESERVED: ReadonlySet<string> = new Set(['map', 'async', 'await']);

export const MODIFIERS: ReadonlySet<string> = new Set(['public', 'protected', 'private', 'static']);

/** Words from JS that MangoScript spells differently. */
export const FOREIGN_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ['function', 'declare functions with "func"'],
  ['var', 'declare variables with "let" or "const"'],
  ['while', 'write loops as "for condition { ... }"'],
]);

/** Keywords that start a statement; used to find where to resume after a syntax error. */
export const STATEMENT_KEYWORDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'import',
  'export',
  'func',
  'comp',
  'let',
  'const',
  'class',
  'interface',
  'type',
  'return',
  'if',
  'for',
  'switch',
  'break',
  'continue',
  'throw',
  'try',
  'defer',
]);

/** Closing brackets and the opening brackets they match. */
export const BRACKETS: Readonly<Partial<Record<TokenKind, TokenKind>>> = {
  ')': '(',
  ']': '[',
  '}': '{',
  TemplateTail: 'TemplateHead',
};

export interface Context {
  /** At the top level of the module, where imports and exports are allowed. */
  topLevel: boolean;
  inFunction: boolean;
  inLoop: boolean;
  /** Inside a loop or switch, where `break` is allowed. */
  inBreakable: boolean;
  inDefer: boolean;
  /** In an if/for/switch header, where `{` starts the block rather than an object literal. */
  noObjectLiteral: boolean;
  /** Inside a component, for the error about `state` in a nested block. */
  inComponent: boolean;
  /** In the blocks of `{if ...}` and `{for ...}` inside markup, where elements are statements. */
  inMarkup: boolean;
}

export const FUNCTION_BODY: Partial<Context> = {
  topLevel: false,
  inFunction: true,
  inLoop: false,
  inBreakable: false,
  inDefer: false,
  noObjectLiteral: false,
  inMarkup: false,
};

/** Thrown to abandon the current statement after its syntax error has been reported. */
export class ParseError extends Error {}

export function describe(token: Token): string {
  switch (token.kind) {
    case 'EOF':
      return 'end of file';
    case ';':
      return token.text === '' ? 'newline' : '";"';
    case 'String':
      return 'string';
    case 'Number':
      return `number ${token.text}`;
    case 'Template':
    case 'TemplateHead':
      return 'template literal';
    default:
      return `"${token.text}"`;
  }
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The text of a template part without its delimiters: "`" or "}" before it, "`" or "${" after it. */
/**
 * Whitespace in markup text as in JSX: lines are trimmed and joined with a space, and lines with
 * only whitespace disappear. Text without line breaks is kept as it is.
 */
export function cleanJsxText(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  lines.forEach((line, i) => {
    let part = line.replace(/\t/g, ' ');
    if (i > 0) part = part.trimStart();
    if (i < lines.length - 1) part = part.trimEnd();
    if (part !== '') kept.push(part);
  });
  return kept.join(' ');
}

/** In `on*` attributes, these are the handler itself rather than code to run. */
export function isHandlerReference(node: ast.Expression): boolean {
  if (
    node.kind === 'Identifier' ||
    node.kind === 'ArrowFunction' ||
    node.kind === 'FuncExpression'
  ) {
    return true;
  }
  return node.kind === 'MemberExpression' && !node.optional && isHandlerReference(node.object);
}

export function templateElement(token: StringToken): ast.TemplateElement {
  const text = token.text;
  const end = text.endsWith('${') ? -2 : text.length > 1 && text.endsWith('`') ? -1 : text.length;
  return {
    kind: 'TemplateElement',
    value: token.value,
    raw: text.slice(1, end),
    start: token.start,
    end: token.end,
  };
}
