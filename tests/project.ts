import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A temporary project directory whose package.json turns markup and components on, as a project
 * with components does: they are off by default (src/config.ts).
 */
export function markupProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ mangoscript: { markup: true } }));

  return dir;
}
