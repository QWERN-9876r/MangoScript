import type * as ast from '../ast.ts';
import { declarationsOf } from './analysis.ts';
import type { JsOptions } from './emitter.ts';
import { FunctionEmitter } from './functions.ts';
import { HELPER_NEEDS, HELPERS, type Helper } from './helpers.ts';

export type { JsOptions } from './emitter.ts';

/** A component whose inlined copies add more lines than this to its module becomes a function. */
export const INLINE_LIMIT = 100;

/**
 * A module whose code creates more elements than this creates them with $$element, which takes
 * their attributes: its definition takes less than the statements it saves.
 */
export const ELEMENT_HELPER_LIMIT = 20;

/**
 * Generates a readable ES module from a program that has parsed without errors. A component is
 * inlined where it is used, unless that adds more than INLINE_LIMIT lines compared to a function
 * and its calls. The module is generated again with each such candidate as a function, and the one
 * that saves the most goes first: that changes the sizes of the components inside it. A component
 * of another module is a candidate too; its function is in that module, and counts as one copy.
 * Then, if the code creates more than ELEMENT_HELPER_LIMIT elements, it is generated again with
 * the helper that creates them.
 */
export function generateJs(program: ast.Program, options: JsOptions): string {
  const { code, functions, elements } = chooseFunctions(program, options);

  if (elements <= ELEMENT_HELPER_LIMIT) return code;

  return new JsGenerator(program, { ...options, functions, elementHelper: true }).generate();
}

/** The code with the components that become functions; see generateJs. */
function chooseFunctions(
  program: ast.Program,
  options: JsOptions,
): { code: string; functions: ReadonlySet<string>; elements: number } {
  const functions = new Set<string>();
  const generate = (names: ReadonlySet<string>) => {
    const generator = new JsGenerator(program, { ...options, functions: names });
    const code = generator.generate();
    const lines = code.split('\n').filter((line) => line.trim() !== '').length;

    return { code, lines, generator };
  };
  let current = generate(functions);

  while (true) {
    let best: (ReturnType<typeof generate> & { name: string; saved: number }) | null = null;
    const { inlined, alwaysInlined } = current.generator;

    for (const [name, { copies, lines }] of inlined) {
      // A function and its calls are larger than one copy, and save no more than the copies take.
      if (copies < 2 || lines <= INLINE_LIMIT || alwaysInlined.has(name)) continue;

      const trial = generate(new Set([...functions, name]));
      const own = options.components?.has(name) ? Math.ceil(lines / copies) : 0;
      const saved = current.lines - trial.lines - own;

      if (saved > INLINE_LIMIT && (!best || saved > best.saved)) best = { ...trial, name, saved };
    }

    if (!best) {
      return { code: current.code, functions, elements: current.generator.createdElements };
    }

    functions.add(best.name);
    current = best;
  }
}

/** The whole module: its statements, plus the helpers that its code needs. */
class JsGenerator extends FunctionEmitter {
  generate(): string {
    this.withScope(declarationsOf(this.program.body), () => {
      this.statements(this.program.body);
      this.webComponentClasses();
      this.hiddenExports();
    });

    // The CSS of the components goes before the code, so that the page has it before the markup.
    const styles = this.styleRegistrations();
    let lines = this.lines;

    if (styles.length > 0) this.helpers.add('style');
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
        ...(styles.length > 0 ? ['', ...styles] : []),
        ...(rest.length > 0 ? [''] : []),
        ...rest,
      ];
    }

    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}
