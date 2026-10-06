import { check } from './checker/checker.ts';
import { generateJs } from './codegen/js.ts';
import type { Diagnostic } from './diagnostics.ts';
import { loadModuleExports } from './modules.ts';
import { parse } from './parser/parser.ts';

export type { Diagnostic } from './diagnostics.ts';
export { formatDiagnostic } from './diagnostics.ts';
export { SourceFile } from './source.ts';

export interface CompileOptions {
  /** Path of the source file; needed to check the types of imported `.mango` modules. */
  filename?: string;
  /**
   * Replace `.mango` with `.js` in relative import paths, for output written next to the sources.
   * Defaults to `true`.
   */
  rewriteImports?: boolean;
  /** Check types before generating code. Defaults to `true`. */
  typeCheck?: boolean;
}

export interface CompileResult {
  /** The generated ES module; empty when there are diagnostics. */
  code: string;
  diagnostics: Diagnostic[];
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const { program, diagnostics } = parse(source);
  if (diagnostics.length > 0) return { code: '', diagnostics };

  if (options.typeCheck ?? true) {
    const { filename } = options;
    const importModule = filename
      ? (specifier: string) => loadModuleExports(filename, specifier)
      : undefined;
    const checked = check(program, importModule ? { importModule } : {});
    if (checked.diagnostics.length > 0) return { code: '', diagnostics: checked.diagnostics };
  }

  const code = generateJs(program, { source, rewriteImports: options.rewriteImports ?? true });
  return { code, diagnostics: [] };
}
