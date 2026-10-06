import type { SourceFile } from './source.ts';

export interface Diagnostic {
  message: string;
  /** Offsets into the source text. */
  start: number;
  end: number;
}

/**
 * Formats a diagnostic in the usual compiler style:
 *
 *     hello.mango:2:9: error: unterminated string literal
 *     2 | let s = "abc
 *       |         ^^^^
 */
export function formatDiagnostic(file: SourceFile, diagnostic: Diagnostic): string {
  const { line, column } = file.position(diagnostic.start);
  const text = file.lineText(line);
  // Keep tabs so that the caret lines up with the source line.
  const indent = text.slice(0, column - 1).replace(/[^\t]/g, ' ');
  const width = Math.max(1, Math.min(diagnostic.end - diagnostic.start, text.length - column + 1));
  const gutter = ' '.repeat(String(line).length);
  return [
    `${file.name}:${line}:${column}: error: ${diagnostic.message}`,
    `${line} | ${text}`,
    `${gutter} | ${indent}${'^'.repeat(width)}`,
  ].join('\n');
}
