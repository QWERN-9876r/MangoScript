import { compileModule } from './compile.ts';
import type { Diagnostic } from './diagnostics.ts';
import { SourceFile } from './source.ts';

// The compiler for the browser, used by the documentation site: everything but reading imported
// modules from disk, so imports are not type checked.

export { tokenize } from './lexer/lexer.ts';
export { KEYWORDS } from './lexer/token.ts';

export interface BrowserDiagnostic {
  message: string;
  /** 1-based position of the start of the problem. */
  line: number;
  column: number;
}

export interface BrowserCompileResult {
  /** The generated ES module; empty when there are diagnostics. */
  code: string;
  diagnostics: BrowserDiagnostic[];
  /** Problems that do not stop compilation. */
  warnings: BrowserDiagnostic[];
  /** The worker module of `go`, when the program has `go`. */
  worker?: string;
}

/** Compiles a program; `workerUrl` is where its worker module of `go` will be, if not next to it. */
export function compile(source: string, workerUrl?: string | null): BrowserCompileResult {
  const result = compileModule(source, {
    rewriteImports: false,
    workerUrl: workerUrl ?? undefined,
  });
  const file = new SourceFile('', source);
  const located = (diagnostic: Diagnostic) => ({
    message: diagnostic.message,
    ...file.position(diagnostic.start),
  });

  return {
    code: result.code,
    diagnostics: result.diagnostics.map(located),
    warnings: result.warnings.map(located),
    ...(result.worker === undefined ? {} : { worker: result.worker }),
  };
}
