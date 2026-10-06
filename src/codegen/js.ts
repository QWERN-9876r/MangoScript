import type * as ast from '../ast.ts';
import { declarationsOf } from './analysis.ts';
import type { JsOptions } from './emitter.ts';
import { FunctionEmitter, RUN_DEFERRED } from './functions.ts';

export type { JsOptions } from './emitter.ts';

/** Generates a readable ES module from a program that has parsed without errors. */
export function generateJs(program: ast.Program, options: JsOptions): string {
  return new JsGenerator(program, options).generate();
}

/** The whole module: its statements, plus the $$runDeferred helper when a function needs it. */
class JsGenerator extends FunctionEmitter {
  generate(): string {
    this.withScope(declarationsOf(this.program.body), () => this.statements(this.program.body));
    let lines = this.lines;
    if (this.usesRunDeferred) {
      let imports = 0;
      while (lines[imports]?.startsWith('import ')) imports++;
      const rest = lines.slice(imports);
      while (rest[0] === '') rest.shift();
      lines = [
        ...lines.slice(0, imports),
        ...(imports > 0 ? [''] : []),
        ...RUN_DEFERRED,
        ...(rest.length > 0 ? [''] : []),
        ...rest,
      ];
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}
