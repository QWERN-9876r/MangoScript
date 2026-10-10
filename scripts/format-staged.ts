import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import * as prettier from 'prettier';

// The pre-commit hook (.husky/pre-commit). It formats the staged version of each file, so the
// commit is formatted however much of a file is staged: ESLint adds the blank lines that Prettier
// keeps but never adds, then Prettier formats. Unstaged edits stay out of the commit, and the
// working copy gets the formatting through a three-way merge, which leaves a file alone rather
// than put an edit in the wrong place (as lint-staged does when formatting adds lines).

function git(args: string[], input?: string): string {
  return execFileSync('git', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

// Only the layout rules, and without type information: the hook has to be fast, and the other
// rules are checked by `npm run lint`.
const eslint = new ESLint({
  fix: true,
  fixTypes: ['layout'],
  ruleFilter: ({ ruleId }) => ruleId.startsWith('@stylistic/'),
  overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
});

async function format(path: string, text: string): Promise<string> {
  if (/\.[cm]?[jt]s$/.test(path) && !(await eslint.isPathIgnored(path))) {
    const [result] = await eslint.lintText(text, { filePath: path });

    text = result?.output ?? text;
  }

  const options = await prettier.resolveConfig(path, { editorconfig: true });

  return prettier.format(text, { ...options, filepath: path });
}

/** Puts the formatting into a working copy with unstaged edits, if they do not overlap it. */
function mergeIntoWorkingCopy(path: string, staged: string, formatted: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'format-staged-'));
  const base = join(directory, 'staged');
  const other = join(directory, 'formatted');

  writeFileSync(base, staged);
  writeFileSync(other, formatted);

  try {
    // Exits with the number of conflicts, so `git` throws on any.
    writeFileSync(path, git(['merge-file', '-p', path, base, other]));
  } catch {
    console.warn(`${path}: unstaged edits overlap the formatting; only the commit is formatted`);
  } finally {
    rmSync(directory, { recursive: true });
  }
}

const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
  .split('\0')
  .filter(Boolean);

for (const path of staged) {
  const [mode] = git(['ls-files', '--stage', '-z', '--', path]).split(' ');

  // Symbolic links and submodules have no text to format.
  if (mode !== '100644' && mode !== '100755') continue;

  const info = await prettier.getFileInfo(path, { ignorePath: ['.gitignore', '.prettierignore'] });

  if (info.ignored || info.inferredParser === null) continue;

  const original = git(['show', `:${path}`]);
  let formatted: string;

  try {
    formatted = await format(path, original);
  } catch (error) {
    console.error(`${path}: cannot be formatted: ${(error as Error).message}`);
    process.exitCode = 1;
    continue;
  }

  if (formatted === original) continue;

  const hash = git(['hash-object', '-w', '--stdin', `--path=${path}`], formatted).trim();

  git(['update-index', '--cacheinfo', `${mode},${hash},${path}`]);

  if (!existsSync(path)) continue;

  if (readFileSync(path, 'utf8') === original) writeFileSync(path, formatted);
  else mergeIntoWorkingCopy(path, original, formatted);
}
