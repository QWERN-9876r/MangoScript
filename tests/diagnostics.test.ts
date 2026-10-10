import { describe, expect, it } from 'vitest';
import { formatDiagnostic } from '../src/diagnostics.ts';
import { SourceFile } from '../src/source.ts';

describe('SourceFile', () => {
  const file = new SourceFile('a.mango', 'ab\ncd\r\n\nef');

  it('maps offsets to lines and columns', () => {
    expect(file.position(0)).toEqual({ line: 1, column: 1 });
    expect(file.position(4)).toEqual({ line: 2, column: 2 });
    expect(file.position(7)).toEqual({ line: 3, column: 1 });
    expect(file.position(9)).toEqual({ line: 4, column: 2 });
  });

  it('returns line text without the line break', () => {
    expect(file.lineText(2)).toBe('cd');
    expect(file.lineText(3)).toBe('');
    expect(file.lineText(4)).toBe('ef');
  });
});

describe('formatDiagnostic', () => {
  it('points at the error in the source line', () => {
    const file = new SourceFile('hello.mango', 'let a = 1\nlet s = "abc\n');
    const diagnostic = { message: 'unterminated string literal', start: 18, end: 22 };

    expect(formatDiagnostic(file, diagnostic)).toBe(
      [
        'hello.mango:2:9: error: unterminated string literal',
        '2 | let s = "abc',
        '  | ' + ' '.repeat(8) + '^^^^',
      ].join('\n'),
    );
  });

  it('keeps tabs so the caret lines up', () => {
    const file = new SourceFile('a.mango', '\tx = @');
    const output = formatDiagnostic(file, {
      message: 'unexpected character "@"',
      start: 5,
      end: 6,
    });

    expect(output.split('\n')[2]).toBe('  | \t    ^');
  });
});
