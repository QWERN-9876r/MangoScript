import { compileModule } from './compile.ts';
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
}

export function compile(source: string): BrowserCompileResult {
  const result = compileModule(source, { rewriteImports: false });
  const file = new SourceFile('', source);
  const diagnostics = result.diagnostics.map((diagnostic) => ({
    message: diagnostic.message,
    ...file.position(diagnostic.start),
  }));
  return { code: result.code, diagnostics };
}
