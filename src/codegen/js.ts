import type * as ast from '../ast.ts';
import { declarationsOf } from './analysis.ts';
import type { JsOptions } from './emitter.ts';
import { FunctionEmitter } from './functions.ts';
import { HELPER_NEEDS, HELPERS, type Helper } from './helpers.ts';

export type { JsOptions } from './emitter.ts';

/** Generates a readable ES module from a program that has parsed without errors. */
export function generateJs(program: ast.Program, options: JsOptions): string {
  return new JsGenerator(program, options).generate();
}

/** The whole module: its statements, plus the helpers that its code needs. */
class JsGenerator extends FunctionEmitter {
  generate(): string {
    this.withScope(declarationsOf(this.program.body), () => this.statements(this.program.body));
    let lines = this.lines;
    if (this.helpers.size > 0) {
      const needed = new Set<Helper>();
      const add = (helper: Helper) => {
        if (needed.has(helper)) return;
        needed.add(helper);
        for (const other of HELPER_NEEDS[helper] ?? []) add(other);
      };
      for (const helper of this.helpers) add(helper);
      const helpers = [...needed]
        .sort()
        .flatMap((helper, i) => [...(i > 0 ? [''] : []), ...HELPERS[helper]]);
      let imports = 0;
      while (lines[imports]?.startsWith('import ')) imports++;
      const rest = lines.slice(imports);
      while (rest[0] === '') rest.shift();
      lines = [
        ...lines.slice(0, imports),
        ...(imports > 0 ? [''] : []),
        ...helpers,
        ...(rest.length > 0 ? [''] : []),
        ...rest,
      ];
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}
