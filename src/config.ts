import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// The settings of a package, in the "rook" field of its package.json:
//
//     "rook": { "markup": true }
//
// Markup and components are off unless the package turns them on, so that Rook can be the
// language of the logic of an app whose views are in React, Svelte or Vue. A file takes the
// settings of the nearest package.json above it, with or without the field; a file without a
// name, those of the current directory. The CLI (--markup, --no-markup) and the Vite plugin
// (`rook({ markup: true })`) may set them for all files instead.

interface PackageSettings {
  markup: boolean;
}

const DEFAULTS: PackageSettings = { markup: false };

/** package.json files read, with the time they were changed: the language server runs long. */
const read = new Map<string, { changed: number; settings: PackageSettings }>();

/** Whether markup and components are on for a file. */
export function markupFor(filename: string | undefined): boolean {
  return settingsFor(resolve(filename ? dirname(filename) : '.')).markup;
}

function settingsFor(start: string): PackageSettings {
  let dir = start;

  while (true) {
    const settings = readSettings(join(dir, 'package.json'));

    if (settings) return settings;
    if (dirname(dir) === dir) return DEFAULTS;
    dir = dirname(dir);
  }
}

/** The settings in a package.json, or null if there is none. */
function readSettings(path: string): PackageSettings | null {
  let changed: number;

  try {
    changed = statSync(path).mtimeMs;
  } catch {
    return null;
  }

  const cached = read.get(path);

  if (cached?.changed === changed) return cached.settings;

  let field: unknown;

  try {
    field = (JSON.parse(readFileSync(path, 'utf8')) as { rook?: unknown }).rook;
  } catch {
    field = undefined;
  }

  const markup = typeof field === 'object' && field !== null && 'markup' in field && field.markup;
  const settings = { markup: markup === true };

  read.set(path, { changed, settings });

  return settings;
}
