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
// not matter, the parser skips the broken statements. If the statement at the cursor is broken
// itself, as code being typed usually is, the rest of its line is cut off and its brackets are
// closed: those of the line, then all those still open, as in a component whose `}` is not written
// yet, then also with an empty body after them, as in `func f(a str|`.

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
/** Keywords only at the start of a statement at the top level of a component or a decorator. */
const COMPONENT_KEYWORDS = ['state', 'derived', 'ref', 'style', 'effect', 'mount'];

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
  const nextLines = after.replace(/^.*/, '');
  const line = source.slice(source.lastIndexOf('\n', start - 1) + 1, start);
  const open = unclosed(source.slice(0, start));
  const attempts = [
    ...new Set([
      before + after,
      before + unclosed(line) + nextLines,
      before + open + nextLines,
      `${before + open} {}${nextLines}`,
    ]),
  ];

  // `<Ca|` without the rest of the element yet.
  if (
    word?.kind === 'JsxName' ||
    tokens.some((each) => each.kind === 'JsxTagOpen' && each.end === start)
  ) {
    attempts.splice(1, 0, `${before} />${after}`);
  }

  for (const text of attempts) {
    const { program } = parse(text, { markup: options.markup ?? true });
    const result = completeIn(program, options);

    if (result) {
      return { start, end: offset, items: withKeywords(result, statementKeywords(program)) };
    }

    // The cursor is where a name is declared, `let ti|`: nothing to suggest.
    if (pathTo(program, CURSOR).length > 0) return empty;
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

function withKeywords({ context, items }: CompletionResult, statement: string[]): Completion[] {
  if (context === 'value') return [...items, ...[...statement, ...VALUE_KEYWORDS].map(keyword)];
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

/**
 * Words that are keywords only at the start of a statement (see src/parser/statements.ts), when the
 * cursor starts one: `select` anywhere, `dec` at the top level of the module and `state` and the
 * like at the top level of a component or a decorator.
 */
function statementKeywords(program: ast.Program): string[] {
  const path = pathTo(program, CURSOR);
  const [statement, block, owner] = [path.at(-2), path.at(-3), path.at(-4)];

  if (statement?.kind !== 'ExpressionStatement') return [];
  if (block?.kind === 'Program') return ['select', 'dec'];

  const component =
    owner?.kind === 'ComponentDeclaration' || owner?.kind === 'DecoratorDeclaration';

  return component && block?.kind === 'BlockStatement'
    ? ['select', ...COMPONENT_KEYWORDS]
    : ['select'];
}

/** The nodes from `node` down to the identifier `name`, both included; empty if it is not there. */
function pathTo(node: ast.Node, name: string): ast.Node[] {
  if (node.kind === 'Identifier' && node.name === name) return [node];

  let path: ast.Node[] = [];

  forEachChild(node, (child) => {
    if (path.length === 0) {
      const below = pathTo(child, name);

      if (below.length > 0) path = [node, ...below];
    }
  });

  return path;
}

/** The brackets that `text` opens and does not close, closed. */
function unclosed(text: string): string {
  const open: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

  for (const { kind } of tokenize(text).tokens) {
    if (kind in pairs) open.push(pairs[kind]!);
    else if (kind === ')' || kind === ']' || kind === '}') open.pop();
  }

  return open.reverse().join('');
}
