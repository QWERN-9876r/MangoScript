import { compileModule, workerUrl, type CompileResult } from './compile.ts';
import { loadModuleExports } from './modules.ts';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  /** Where the worker module of `go` is, relative to the module; see workerUrl() in compile.ts. */
  workerUrl?: string;
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const { filename } = options;
  const rewriteImports = options.rewriteImports ?? true;

  return compileModule(source, {
    rewriteImports,
    workerUrl: options.workerUrl ?? workerUrl(filename ?? 'main.mango', rewriteImports),
    typeCheck: options.typeCheck ?? true,
    declarations: options.declarations ?? false,
    importModule: filename
      ? (specifier: string) => loadModuleExports(filename, specifier)
      : undefined,
    importDeclarations: filename
      ? (specifier: string) => importDeclarations(filename, specifier)
      : undefined,
    readStyleModule: filename ? (specifier: string) => readNear(filename, specifier) : undefined,
    // Without a file name, `@types` packages are looked up from the current directory.
    library:
      (options.typeCheck ?? true)
        ? libraryFor(filename ?? join(process.cwd(), 'main.mango'))
        : undefined,
  });
}

/** A file next to `filename`, or null if it cannot be read. */
function readNear(filename: string, specifier: string): string | null {
  try {
    return readFileSync(resolve(dirname(filename), specifier), 'utf8');
  } catch {
    return null;
  }
}
