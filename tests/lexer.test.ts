import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/lexer/lexer.ts';
import type { Token } from '../src/lexer/token.ts';

/** Token texts, with automatic semicolons shown as "⏎" and EOF dropped. Fails on diagnostics. */
function texts(source: string): string[] {
  const { tokens, diagnostics } = tokenize(source);

  expect(diagnostics).toEqual([]);

  return tokens
    .filter((t) => t.kind !== 'EOF')
    .map((t) => (t.kind === ';' && t.text === '' ? '⏎' : t.text));
}

function kinds(source: string): string[] {
  const { tokens, diagnostics } = tokenize(source);

  expect(diagnostics).toEqual([]);

  return tokens.map((t) => t.kind);
}

function errors(source: string): string[] {
  return tokenize(source).diagnostics.map((d) => d.message);
}

/** The first token of a one-token source. */
function single(source: string): Token {
  const { tokens, diagnostics } = tokenize(source);

  expect(diagnostics).toEqual([]);

  return tokens[0]!;
}

describe('identifiers and keywords', () => {
  it('distinguishes keywords from identifiers', () => {
    expect(kinds('func main')).toEqual(['func', 'Identifier', ';', 'EOF']);
    expect(kinds('typeof x instanceof Y')).toEqual([
      'typeof',
      'Identifier',
      'instanceof',
      'Identifier',
      ';',
      'EOF',
    ]);
  });

  it('treats predeclared types and contextual words as identifiers', () => {
    const words = ['number', 'string', 'bool', 'any', 'error', 'static', 'private', 'from'];

    expect(kinds(words.join(' '))).toEqual([...words.map(() => 'Identifier'), ';', 'EOF']);
  });

  it('supports unicode, $ and _ in identifiers', () => {
    expect(texts('let имя = $el + _x1')).toEqual(['let', 'имя', '=', '$el', '+', '_x1', '⏎']);
  });

  it('reserves names starting with $$ for generated code', () => {
    expect(errors('let $$defer = 1')).toEqual([
      'names starting with "$$" are reserved for generated code',
    ]);
  });
});

describe('numbers', () => {
  it.each([
    ['0', 0],
    ['42', 42],
    ['3.14', 3.14],
    ['.5', 0.5],
    ['1e3', 1000],
    ['2.5E-3', 0.0025],
    ['0xff', 255],
    ['0b101', 5],
    ['0o17', 15],
    ['1_000_000', 1_000_000],
  ])('%s', (source, value) => {
    expect(single(source)).toMatchObject({ kind: 'Number', text: source, value });
  });

  it('does not treat a dot without digits as part of the number', () => {
    expect(texts('1.toFixed(2)')).toEqual(['1', '.', 'toFixed', '(', '2', ')', '⏎']);
  });

  it.each([
    ['1__0', '"_" can only appear between digits'],
    ['1_', '"_" can only appear between digits'],
    ['0x_1', '"_" can only appear between digits'],
    ['0x', 'expected digits after "0x"'],
    ['1e', 'expected digits in exponent'],
    ['007', 'leading zeros are not allowed'],
    ['123abc', 'identifier cannot start immediately after a number'],
  ])('reports %s', (source, message) => {
    expect(errors(source)).toEqual([expect.stringContaining(message)]);
  });
});

describe('strings', () => {
  it('accepts both quote styles', () => {
    expect(single('"hi"')).toMatchObject({ kind: 'String', value: 'hi' });
    expect(single("'hi'")).toMatchObject({ kind: 'String', value: 'hi' });
  });

  it('decodes escape sequences', () => {
    expect(single(String.raw`"a\n\t\"\\\'"`)).toMatchObject({ value: 'a\n\t"\\\'' });
    expect(single(String.raw`"\x41B\u{1F96D}"`)).toMatchObject({ value: 'AB🥭' });
  });

  it.each([
    ['"abc', 'unterminated string literal'],
    ['"abc\nx', 'unterminated string literal'],
    [String.raw`"\q"`, 'unknown escape sequence "\\q"'],
    [String.raw`"\x4"`, 'expected two hex digits after "\\x"'],
    [String.raw`"\u{110000}"`, 'expected "\\uXXXX" or "\\u{X...}"'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([expect.stringContaining(message)]);
  });
});

describe('template literals', () => {
  it('lexes a template without substitutions as one token', () => {
    expect(single('`a\nb`')).toMatchObject({ kind: 'Template', value: 'a\nb' });
  });

  it('splits a template around substitutions', () => {
    const { tokens } = tokenize('`a${x}b${y}c`');

    expect(tokens.map((t) => [t.kind, 'value' in t ? t.value : t.text])).toEqual([
      ['TemplateHead', 'a'],
      ['Identifier', 'x'],
      ['TemplateMiddle', 'b'],
      ['Identifier', 'y'],
      ['TemplateTail', 'c'],
      [';', ''],
      ['EOF', ''],
    ]);
  });

  it('tracks braces inside substitutions', () => {
    expect(kinds('`${ {a: 1}.a }`')).toEqual([
      'TemplateHead',
      '{',
      'Identifier',
      ':',
      'Number',
      '}',
      '.',
      'Identifier',
      'TemplateTail',
      ';',
      'EOF',
    ]);
  });

  it('supports nested templates', () => {
    expect(kinds('`a${`b${c}`}d`')).toEqual([
      'TemplateHead',
      'TemplateHead',
      'Identifier',
      'TemplateTail',
      'TemplateTail',
      ';',
      'EOF',
    ]);
  });

  it.each(['`abc', '`a${x', '`a${x}b'])('reports unterminated %j', (source) => {
    expect(errors(source)).toEqual(['unterminated template literal']);
  });
});

describe('punctuators', () => {
  it('uses the longest match', () => {
    expect(texts('a >>>= b ** c ?? d...e')).toEqual([
      'a',
      '>>>=',
      'b',
      '**',
      'c',
      '??',
      'd',
      '...',
      'e',
      '⏎',
    ]);
  });

  it('distinguishes optional chaining from a conditional with a fraction', () => {
    expect(texts('a?.b')).toEqual(['a', '?.', 'b', '⏎']);
    expect(texts('a?.5:1')).toEqual(['a', '?', '.5', ':', '1', '⏎']);
  });

  it('suggests == instead of ===', () => {
    const { tokens, diagnostics } = tokenize('a === b');

    expect(tokens[1]).toMatchObject({ kind: '==', text: '===' });
    expect(diagnostics).toEqual([
      { message: '"===" is not needed: "==" is already strict', start: 2, end: 5 },
    ]);
  });

  it('reports unknown characters', () => {
    expect(errors('a # b')).toEqual(['unexpected character "#"']);
  });
});

describe('comments', () => {
  it('skips line and block comments', () => {
    expect(texts('a // note\nb /* inline */ c')).toEqual(['a', '⏎', 'b', 'c', '⏎']);
  });

  it('treats a multi-line block comment as a line break', () => {
    expect(texts('a /* one\ntwo */ b')).toEqual(['a', '⏎', 'b', '⏎']);
  });

  it('reports an unterminated block comment', () => {
    expect(errors('a /* oops')).toEqual(['unterminated block comment']);
  });
});

describe('automatic semicolons', () => {
  it.each([
    'x',
    '42',
    '"s"',
    '`t`',
    '`${x}`',
    'true',
    'false',
    'null',
    'this',
    'return',
    'break',
    'continue',
    'i++',
    'i--',
    'f()',
    'a[0]',
    '{}',
  ])('inserts a semicolon after %j at the end of a line', (line) => {
    expect(texts(`${line}\nnext`).slice(-3)).toEqual(['⏎', 'next', '⏎']);
  });

  it.each(['a +', 'a =', 'a,', 'a.', 'f(', 'xs[', 'if x {', 'func', '() =>'])(
    'does not insert one after %j',
    (line) => {
      const result = texts(`${line}\nb`);

      expect(result[result.indexOf('b') - 1]).not.toBe('⏎');
    },
  );

  it('inserts a single semicolon for several blank lines', () => {
    expect(texts('a\n\n\nb')).toEqual(['a', '⏎', 'b', '⏎']);
  });

  it('inserts a semicolon at the end of input', () => {
    expect(texts('a')).toEqual(['a', '⏎']);
  });

  it('does not duplicate an explicit semicolon', () => {
    expect(texts('a;\nb')).toEqual(['a', ';', 'b', '⏎']);
  });

  it('continues a method chain on the next line', () => {
    const source = 'users\n  .filter(f)\n  // only names\n  ?.map(g)\nnext';

    expect(texts(source)).toEqual([
      ...['users', '.', 'filter', '(', 'f', ')', '?.', 'map', '(', 'g', ')', '⏎'],
      ...['next', '⏎'],
    ]);
  });

  it('does not insert one before a closing bracket', () => {
    expect(texts('f(\n  a,\n  b\n)')).toEqual(['f', '(', 'a', ',', 'b', ')', '⏎']);
    expect(texts('[\n  1\n]')).toEqual(['[', '1', ']', '⏎']);
    expect(texts('{\n  x: 1\n}')).toEqual(['{', 'x', ':', '1', '}', '⏎']);
  });

  it('places the semicolon right after the previous token', () => {
    expect(tokenize('ab\ncd').tokens[1]).toEqual({ kind: ';', text: '', start: 2, end: 2 });
  });
});

it('records token offsets', () => {
  const offsets = tokenize('let x = 10').tokens.map((t) => [t.start, t.end]);

  expect(offsets).toEqual([
    [0, 3],
    [4, 5],
    [6, 7],
    [8, 10],
    [10, 10],
    [10, 10],
  ]);
});

it('tokenizes examples/hello.mango without errors', () => {
  const source = readFileSync(new URL('../examples/hello.mango', import.meta.url), 'utf8');

  expect(tokenize(source).diagnostics).toEqual([]);
});
