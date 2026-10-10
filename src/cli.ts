#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build, displayPath } from './build.ts';
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
  mango build <file.mango | dir>...   Compile to .js files, with the .mango files they import
  mango run <file.mango>              Compile and run, with the .mango files it imports
  mango tokens <file.mango>           Print lexer tokens (for debugging)
  mango ast <file.mango>              Print the syntax tree (for debugging)

Options:
      --out-dir <dir>   build: write the .js files to <dir>, keeping the folder structure
                        (by default they go next to the .mango files)
      --stdout          build: print the JS of a single file instead of writing files
      --no-check        Skip type checking
  -h, --help            Show this help
  -v, --version         Show version`;

/** A mistake in how the CLI was called. */
class UsageError extends Error {}

/** Compile errors, already formatted for the terminal. */
class CompileError extends Error {}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'out-dir': { type: 'string' },
      stdout: { type: 'boolean' },
      'no-check': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) {
    console.log(version);

    return;
  }

  const [command, ...files] = positionals;

  if (values.help || !command) {
    console.log(HELP);

    return;
  }

  if (files.length === 0) throw new UsageError(`missing input file for "${command}"`);
  for (const path of files) {
    if (!existsSync(path)) throw new UsageError(`file not found: ${path}`);
  }

  if (command !== 'build' && files.length > 1) {
    throw new UsageError(`"${command}" takes a single file`);
  }

  const file = files[0]!;
  const typeCheck = !values['no-check'];

  switch (command) {
    case 'build':
      if (values.stdout) {
        if (files.length > 1 || statSync(file).isDirectory()) {
          throw new UsageError('--stdout needs a single .mango file');
        }

        process.stdout.write(compileFile(file, { rewriteImports: true, typeCheck }));
      } else {
        buildFiles(files, values['out-dir'], typeCheck);
      }

      break;

    case 'run':
      registerMangoLoader(typeCheck);
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

/** Builds the files and directories and writes the `.js` files, or none if there are errors. */
function buildFiles(entries: string[], outDir: string | undefined, typeCheck: boolean): void {
  for (const entry of entries) {
    if (!statSync(entry).isDirectory() && !entry.endsWith('.mango')) {
      throw new UsageError(`not a .mango file: ${entry}`);
    }
  }

  const { outputs, errors } = build(entries, { outDir, typeCheck });

  if (errors.length > 0) {
    const messages = errors.flatMap(({ file, diagnostics }) =>
      diagnostics.map((diagnostic) => formatDiagnostic(file, diagnostic)),
    );

    throw new CompileError(messages.join('\n\n'));
  }

  for (const { source, output, code, declarations } of outputs) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, code);
    if (declarations) writeFileSync(declarations.output, declarations.code);
    console.log(`${displayPath(source)} → ${displayPath(output)}${declarations ? ' + .d.ts' : ''}`);
  }
}

function compileFile(
  path: string,
  options: { rewriteImports: boolean; typeCheck: boolean },
): string {
  const source = readFileSync(path, 'utf8');
  const { code, diagnostics } = compile(source, { filename: path, ...options });

  if (diagnostics.length > 0) {
    const file = new SourceFile(path, source);

    throw new CompileError(diagnostics.map((d) => formatDiagnostic(file, d)).join('\n\n'));
  }

  return code;
}

/** Lets Node import `.mango` files directly by compiling them on load. */
function registerMangoLoader(typeCheck: boolean): void {
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !url.endsWith('.mango')) return nextLoad(url, context);

      const path = displayPath(fileURLToPath(url));
      const source = compileFile(path, { rewriteImports: false, typeCheck });

      return { format: 'module', source, shortCircuit: true };
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
