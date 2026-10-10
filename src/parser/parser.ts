import type * as ast from '../ast.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { tokenize } from '../lexer/lexer.ts';
import { MarkupParser } from './markup.ts';

export interface ParseResult {
  program: ast.Program;
  /** Lexer and parser errors, sorted by position. */
  diagnostics: Diagnostic[];
}

// The parser of a module; its layers are listed in base.ts.

class Parser extends MarkupParser {
  parseProgram(): ast.Program {
    const body = this.parseStatements(() => false);

    return { kind: 'Program', body, start: 0, end: this.peek().end };
  }
}

export function parse(text: string): ParseResult {
  const { tokens, diagnostics } = tokenize(text);
  const parser = new Parser(tokens);
  const program = parser.parseProgram();

  return {
    program,
    diagnostics: [...diagnostics, ...parser.diagnostics].sort((a, b) => a.start - b.start),
  };
}
