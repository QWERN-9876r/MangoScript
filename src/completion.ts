import type * as ast from './ast.ts';
import { check, type Completion, type CompletionResult } from './checker/checker.ts';
import { prepareCheck, type CoreCompileOptions } from './compile.ts';
import { tokenize } from './lexer/lexer.ts';
import { KEYWORDS, type Token } from './lexer/token.ts';
import { parse } from './parser/parser.ts';
import { RESERVED } from './parser/syntax.ts';
import { forEachChild } from './walk.ts';

// Completion for editors: what can be written at a position of a module. The name being typed
// is replaced with CURSOR, a name that programs cannot use, and the module is checked: the checker
// lists what fits where it meets that name (src/checker/completion.ts). Syntax errors elsewhere do
// not matter, the parser skips the broken statements; if the statement at the cursor is broken
// itself, the rest of its line is cut off and its brackets are closed.

export type { Completion, CompletionContext } from './checker/checker.ts';

const CURSOR = '$$cursor';

export interface CompletionList {
  /** Offsets of what the chosen item replaces: the part of the name before the cursor. */
  start: number;
  end: number;
  items: Completion[];
}

const STRINGS = new Set<Token['kind']>([
  'String',
  'Template',
  'TemplateHead',
  'TemplateMiddle',
  'TemplateTail',
  'JsxText',
  'JsxString',
  'CssText',
]);

const VALUE_KEYWORDS = KEYWORDS.filter((keyword) => !RESERVED.has(keyword));
const TYPE_KEYWORDS = ['func', 'comp', 'chan'];

export function completeModule(
  source: string,
  offset: number,
  options: CoreCompileOptions = {},
): CompletionList {
  const { tokens } = tokenize(source);
  const empty = { start: offset, end: offset, items: [] };
  const token = tokens.find((each) => each.start < offset && offset <= each.end);

  if (token && STRINGS.has(token.kind) && offset < token.end) return empty;
  if (token?.kind === 'Number' || (!token && inComment(source, tokens, offset))) return empty;

  // The name being typed, `ti|tle`, is replaced as a whole.
  const word = token && /^[\p{ID_Start}$_]/u.test(token.text) ? token : null;
  const start = word?.start ?? offset;
  const end = word?.end ?? offset;
  const before = source.slice(0, start) + CURSOR;
  const after = source.slice(end);
  const attempts = [before + after, before + closing(source, start) + after.replace(/^.*/, '')];

  // `<Ca|` without the rest of the element yet.
  if (
    word?.kind === 'JsxName' ||
    tokens.some((each) => each.kind === 'JsxTagOpen' && each.end === start)
  ) {
    attempts.splice(1, 0, `${before} />${after}`);
  }

  for (const text of attempts) {
    const { program } = parse(text);
    const result = completeIn(program, options);

    if (result) return { start, end: offset, items: withKeywords(result) };
    // The cursor is where a name is declared, `let ti|`: nothing to suggest.
    if (contains(program, CURSOR)) return empty;
  }

  return { start, end: offset, items: VALUE_KEYWORDS.map(keyword) };
}

function completeIn(program: ast.Program, options: CoreCompileOptions): CompletionResult | null {
  const { checkOptions } = prepareCheck(program, options);

  try {
    return check(program, { ...checkOptions, completion: CURSOR }).completion ?? null;
  } catch {
    // The tree that the parser recovered from errors may surprise the checker.
    return null;
  }
}

function withKeywords({ context, items }: CompletionResult): Completion[] {
  if (context === 'value') return [...items, ...VALUE_KEYWORDS.map(keyword)];
  if (context === 'type') return [...items, ...TYPE_KEYWORDS.map(keyword)];

  return items;
}

function keyword(name: string): Completion {
  return { name, kind: 'keyword' };
}

/** Whether the offset is in a comment: comments are the only text between tokens. */
function inComment(source: string, tokens: readonly Token[], offset: number): boolean {
  const previous = tokens.findLast((each) => each.end <= offset && each.text !== '');
  const gap = source.slice(previous?.end ?? 0, offset);
  const block = gap.lastIndexOf('/*');

  return gap.slice(gap.lastIndexOf('\n') + 1).includes('//') || block > gap.lastIndexOf('*/');
}

/** The brackets that the line before `offset` opens and does not close, closed. */
function closing(source: string, offset: number): string {
  const line = tokenize(source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset)).tokens;
  const open: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

  for (const { kind } of line) {
    if (kind in pairs) open.push(pairs[kind]!);
    else if (kind === ')' || kind === ']' || kind === '}') open.pop();
  }

  return open.reverse().join('');
}

function contains(node: ast.Node, name: string): boolean {
  if (node.kind === 'Identifier' && node.name === name) return true;

  let found = false;

  forEachChild(node, (child) => {
    found ||= contains(child, name);
  });

  return found;
}
