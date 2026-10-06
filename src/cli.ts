#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatDiagnostic, type Diagnostic } from './diagnostics.ts';
import { compile } from './index.ts';
import { tokenize } from './lexer/lexer.ts';
import { parse } from './parser/parser.ts';
import { SourceFile } from './source.ts';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

const HELP = `MangoScript ${version}

Usage:
  mango build <file.mango> [-o <out.js>]   Compile to JavaScript (stdout by default)
  mango run <file.mango>                   Compile and run, with imports of other .mango files
  mango tokens <file.mango>                Print lexer tokens (for debugging)
  mango ast <file.mango>                   Print the syntax tree (for debugging)

Options:
  -o, --out <file>   Output file
  -h, --help         Show this help
  -v, --version      Show version`;

/** A mistake in how the CLI was called. */
class UsageError extends Error {}

/** Compile errors, already formatted for the terminal. */
class CompileError extends Error {}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) {
    console.log(version);
    return;
  }

  const [command, file] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  if (!file) throw new UsageError(`missing input file for "${command}"`);
  if (!existsSync(file)) throw new UsageError(`file not found: ${file}`);

  switch (command) {
    case 'build': {
      const code = compileFile(file, true);
      if (values.out) writeFileSync(values.out, code);
      else process.stdout.write(code);
      break;
    }
    case 'run':
      registerMangoLoader();
      await import(pathToFileURL(resolve(file)).href);
      break;
    case 'tokens':
      printTokens(new SourceFile(file, readFileSync(file, 'utf8')));
      break;
    case 'ast':
      printAst(new SourceFile(file, readFileSync(file, 'utf8')));
      break;
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

function compileFile(path: string, rewriteImports: boolean): string {
  const source = readFileSync(path, 'utf8');
  const { code, diagnostics } = compile(source, { filename: path, rewriteImports });
  if (diagnostics.length > 0) {
    const file = new SourceFile(path, source);
    throw new CompileError(diagnostics.map((d) => formatDiagnostic(file, d)).join('\n\n'));
  }
  return code;
}

/** Lets Node import `.mango` files directly by compiling them on load. */
function registerMangoLoader(): void {
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !url.endsWith('.mango')) return nextLoad(url, context);
      // Error messages show paths relative to the current directory when that is shorter.
      const absolute = fileURLToPath(url);
      const fromCwd = relative(process.cwd(), absolute);
      const path = fromCwd.startsWith('..') ? absolute : fromCwd;
      return { format: 'module', source: compileFile(path, false), shortCircuit: true };
    },
  });
}

function printTokens(file: SourceFile): void {
  const { tokens, diagnostics } = tokenize(file.text);
  for (const token of tokens) {
    const { line, column } = file.position(token.start);
    const text = token.kind === ';' && token.text === '' ? '(newline)' : JSON.stringify(token.text);
    console.log(`${line}:${column}`.padEnd(8) + token.kind.padEnd(16) + text);
  }
  reportDiagnostics(file, diagnostics);
}

function printAst(file: SourceFile): void {
  const { program, diagnostics } = parse(file.text);
  // Positions are left out and identifiers printed as plain names to keep the output readable.
  const compact = (key: string, value: unknown): unknown => {
    if (key === 'start' || key === 'end' || key === 'raw') return undefined;
    if (typeof value === 'object' && value !== null && 'kind' in value && 'name' in value) {
      if (value.kind === 'Identifier') return value.name;
    }
    return value;
  };
  console.log(JSON.stringify(program, compact, 2));
  reportDiagnostics(file, diagnostics);
}

function reportDiagnostics(file: SourceFile, diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) console.error(`${formatDiagnostic(file, diagnostic)}\n`);
  if (diagnostics.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof CompileError) console.error(err.message);
  else if (err instanceof UsageError) console.error(`mango: ${err.message}`);
  // Anything else is thrown by the running program: show the full stack trace.
  else console.error(err);
  process.exitCode = 1;
});
