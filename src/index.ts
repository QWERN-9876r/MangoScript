import { generateJs } from './codegen/js.ts';
import type { Diagnostic } from './diagnostics.ts';
import { parse } from './parser/parser.ts';

export type { Diagnostic } from './diagnostics.ts';
export { formatDiagnostic } from './diagnostics.ts';
export { SourceFile } from './source.ts';

export interface CompileOptions {
  /** Used in diagnostics and source maps. */
  filename?: string;
  /**
   * Replace `.mango` with `.js` in relative import paths, for output written next to the sources.
   * Defaults to `true`.
   */
  rewriteImports?: boolean;
}

export interface CompileResult {
  /** The generated ES module; empty when there are diagnostics. */
  code: string;
  diagnostics: Diagnostic[];
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const { program, diagnostics } = parse(source);
  if (diagnostics.length > 0) return { code: '', diagnostics };
  const code = generateJs(program, { source, rewriteImports: options.rewriteImports ?? true });
  return { code, diagnostics: [] };
}
