import { compileModule, type CompileResult } from './compile.ts';
import { loadModuleExports } from './modules.ts';
import { join } from 'node:path';
import { importDeclarations, libraryFor } from './typescript/importer.ts';

export type { CompileResult } from './compile.ts';
export type { Diagnostic } from './diagnostics.ts';
export { formatDiagnostic } from './diagnostics.ts';
export { SourceFile } from './source.ts';

export interface CompileOptions {
  /** Path of the source file; needed to check the types of imports. */
  filename?: string;
  /**
   * Replace `.mango` with `.js` in relative import paths, for output written next to the sources.
   * Defaults to `true`.
   */
  rewriteImports?: boolean;
  /** Check types before generating code. Defaults to `true`. */
  typeCheck?: boolean;
  /** Also print a TypeScript declaration file (`.d.ts`); needs type checking. */
  declarations?: boolean;
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const { filename } = options;
  return compileModule(source, {
    rewriteImports: options.rewriteImports ?? true,
    typeCheck: options.typeCheck ?? true,
    declarations: options.declarations ?? false,
    importModule: filename
      ? (specifier: string) => loadModuleExports(filename, specifier)
      : undefined,
    importDeclarations: filename
      ? (specifier: string) => importDeclarations(filename, specifier)
      : undefined,
    // Without a file name, `@types` packages are looked up from the current directory.
    library: libraryFor(filename ?? join(process.cwd(), 'main.mango')),
  });
}
