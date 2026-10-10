import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Diagnostic } from './diagnostics.ts';
import { compile } from './index.ts';
import { SourceFile } from './source.ts';

export interface BuildOptions {
  /** Write the `.js` files here, keeping the folder structure; by default they go next to the sources. */
  outDir?: string;
  /** Check types before generating code. Defaults to `true`. */
  typeCheck?: boolean;
  /** Write a `.d.ts` next to each `.js`, for TypeScript code. Defaults to `typeCheck`. */
  declarations?: boolean;
}

export interface BuildOutput {
  /** Absolute path of the `.mango` file. */
  source: string;
  /** Absolute path of its `.js` file. */
  output: string;
  code: string;
  /** Its `.d.ts` file, when declarations are written. */
  declarations?: { output: string; code: string };
}

export interface BuildError {
  file: SourceFile;
  diagnostics: Diagnostic[];
}

export interface BuildResult {
  /** Empty when there are errors: either every file is built or none. */
  outputs: BuildOutput[];
  errors: BuildError[];
}

/**
 * Compiles `.mango` files and directories (recursively), together with every `.mango` file they
 * import, since the generated imports refer to the `.js` files of those modules.
 */
export function build(entries: readonly string[], options: BuildOptions = {}): BuildResult {
  const directories = entries
    .map((entry) => resolve(entry))
    .filter((path) => statSync(path).isDirectory());
  const queue = entries.flatMap((entry) => {
    const path = resolve(entry);

    return directories.includes(path) ? findMangoFiles(path) : [path];
  });
  const seen = new Set(queue);
  const typeCheck = options.typeCheck ?? true;
  const declarations = typeCheck && (options.declarations ?? true);
  const compiled: { source: string; code: string; declarations: string | undefined }[] = [];
  const errors: BuildError[] = [];

  for (let i = 0; i < queue.length; i++) {
    const source = queue[i]!;
    const text = readFileSync(source, 'utf8');
    const result = compile(text, { filename: source, typeCheck, declarations });

    if (result.diagnostics.length > 0) {
      errors.push({
        file: new SourceFile(displayPath(source), text),
        diagnostics: result.diagnostics,
      });
    } else {
      compiled.push({ source, code: result.code, declarations: result.declarations });
    }

    for (const specifier of result.dependencies) {
      // A missing module is reported by the type checker.
      const dependency = resolve(dirname(source), specifier);

      if (!seen.has(dependency) && existsSync(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
  }

  if (errors.length > 0) return { outputs: [], errors };

  // The output keeps the folder structure below the given directories and all the files.
  const root = commonDirectory(queue, directories);
  const outputs = compiled.map(({ source, code, declarations: types }): BuildOutput => {
    const target = options.outDir ? join(resolve(options.outDir), relative(root, source)) : source;
    const base = target.replace(/\.mango$/, '');

    return {
      source,
      output: `${base}.js`,
      code,
      ...(types === undefined ? {} : { declarations: { output: `${base}.d.ts`, code: types } }),
    };
  });

  return { outputs, errors };
}

/** The `.mango` files in a directory and its subdirectories, except `node_modules` and hidden ones. */
function findMangoFiles(directory: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...findMangoFiles(path));
      }
    } else if (entry.name.endsWith('.mango')) {
      files.push(path);
    }
  }

  return files;
}

/** The deepest directory that contains all the files and directories. */
function commonDirectory(files: readonly string[], directories: readonly string[]): string {
  const inside = (path: string, directory: string) => path.startsWith(directory + sep);
  let directory = directories[0] ?? dirname(files[0] ?? process.cwd());

  while (
    !files.every((file) => inside(file, directory)) ||
    !directories.every((other) => other === directory || inside(other, directory))
  ) {
    const parent = dirname(directory);

    if (parent === directory) break;
    directory = parent;
  }

  return directory;
}

/** A path for messages: relative to the current directory when it is inside it. */
export function displayPath(path: string): string {
  const fromCwd = relative(process.cwd(), path);

  return fromCwd.startsWith('..') ? path : fromCwd;
}
