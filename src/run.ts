import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompileError } from './compile-file.ts';

// The process of `rook run`, started with `--import` of loader.ts: it runs the program and shows
// compile errors without a stack trace.

try {
  await import(pathToFileURL(resolve(process.argv[2]!)).href);
} catch (err) {
  // Anything else is thrown by the running program: show the full stack trace.
  console.error(err instanceof CompileError ? err.message : err);
  process.exitCode = 1;
}
