import {
  compileModule,
  workerUrl,
  type CompileResult,
  type CoreCompileOptions,
} from './compile.ts';
import { completeModule, type CompletionList } from './completion.ts';
import { loadModuleExports } from './modules.ts';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { importDeclarations, libraryFor } from './typescript/importer.ts';

export type { CompileResult } from './compile.ts';
export type { Completion, CompletionList } from './completion.ts';
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
    ...filesOf(filename, options.typeCheck ?? true),
    rewriteImports,
    workerUrl: options.workerUrl ?? workerUrl(filename ?? 'main.mango', rewriteImports),
    typeCheck: options.typeCheck ?? true,
    declarations: options.declarations ?? false,
  });
}

/**
 * What can be written at `offset` in a module, for editors: names, members, types, tags and
 * attributes. The imports are read from disk, like those of `compile`.
 */
export function complete(
  source: string,
  offset: number,
  options: { filename?: string } = {},
): CompletionList {
  return completeModule(source, offset, filesOf(options.filename, true));
}

/** Reading what a module imports: other modules, declarations, CSS modules and the library. */
function filesOf(
  filename: string | undefined,
  typeCheck: boolean,
): Pick<CoreCompileOptions, 'importModule' | 'importDeclarations' | 'readStyleModule' | 'library'> {
  return {
    importModule: filename
      ? (specifier: string) => loadModuleExports(filename, specifier)
      : undefined,
    importDeclarations: filename
      ? (specifier: string) => importDeclarations(filename, specifier)
      : undefined,
    readStyleModule: filename ? (specifier: string) => readNear(filename, specifier) : undefined,
    // Without a file name, `@types` packages are looked up from the current directory.
    library: typeCheck ? libraryFor(filename ?? join(process.cwd(), 'main.mango')) : undefined,
  };
}

/** A file next to `filename`, or null if it cannot be read. */
function readNear(filename: string, specifier: string): string | null {
  try {
    return readFileSync(resolve(dirname(filename), specifier), 'utf8');
  } catch {
    return null;
  }
}
