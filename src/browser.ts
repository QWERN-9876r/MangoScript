import { compileModule } from './compile.ts';
import { completeModule, type CompletionList } from './completion.ts';
import type { Diagnostic } from './diagnostics.ts';
import { SourceFile } from './source.ts';

// The compiler for the browser, used by the documentation site: everything but reading imported
// modules from disk, so imports are not type checked. Completion is the one of the language server.
// There is no package.json here: markup and components are on only with `{ markup: true }`.

export { tokenize } from './lexer/lexer.ts';
export { KEYWORDS } from './lexer/token.ts';
export type { Completion, CompletionList } from './completion.ts';

export interface BrowserDiagnostic {
  message: string;
  /** 1-based position of the start of the problem. */
  line: number;
  column: number;
  /** 1-based position just after its end. */
  endLine: number;
  endColumn: number;
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

export interface BrowserOptions {
  /** Markup and components; off by default, as in a package without them. */
  markup?: boolean;
}

/** Compiles a program; `workerUrl` is where its worker module of `go` will be, if not next to it. */
export function compile(
  source: string,
  workerUrl?: string | null,
  options: BrowserOptions = {},
): BrowserCompileResult {
  const result = compileModule(source, {
    rewriteImports: false,
    workerUrl: workerUrl ?? undefined,
    markup: options.markup ?? false,
  });
  const file = new SourceFile('', source);
  const located = (diagnostic: Diagnostic) => {
    const end = file.position(diagnostic.end);

    return {
      message: diagnostic.message,
      ...file.position(diagnostic.start),
      endLine: end.line,
      endColumn: end.column,
    };
  };

  return {
    code: result.code,
    diagnostics: result.diagnostics.map(located),
    warnings: result.warnings.map(located),
    ...(result.worker === undefined ? {} : { worker: result.worker }),
  };
}

/** What can be written at `offset` of a program: names, properties, tags and attributes. */
export function complete(
  source: string,
  offset: number,
  options: BrowserOptions = {},
): CompletionList {
  return completeModule(source, offset, { markup: options.markup ?? false });
}
