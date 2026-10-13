import type * as ast from './ast.ts';
import { hash } from './css/hash.ts';
import { parseCss } from './css/parse.ts';
import { printCss, valueText } from './css/print.ts';
import { renameClasses } from './css/selectors.ts';
import { forEachChild } from './walk.ts';

// CSS modules: `import styles from "./button.module.css"`. The compiler reads the file: its classes
// get names of its own, `button_k3f9a`, and `styles` is an object of them, typed, so a typo is a
// compile error. Tags, `:root` and `:global(...)` stay as they are, so a module can hold the
// tokens of a theme too. The module that imports it adds the CSS to the page, as styles of
// components are added.

export interface StyleModule {
  /** The hash of the CSS: the suffix of its classes and the id of its `<style>`. */
  id: string;
  /** Its classes, in the order they are written, and the names they get. */
  classes: Map<string, string>;
  css: string;
  problems: string[];
}

/** Whether an import is of a CSS module. */
export function isStyleModule(specifier: string): boolean {
  return specifier.endsWith('.module.css');
}

export function styleModule(text: string): StyleModule {
  const id = hash(text);
  const sheet = parseCss(text);
  const classes = new Map<string, string>();
  const css = printCss(sheet.nodes, {
    selector: (selector) =>
      renameClasses(
        selector,
        (name) => `${name}_${id}`,
        (name) => classes.set(name, `${name}_${id}`),
      ),
    value: (declaration) => valueText(declaration, () => ''),
  });

  return { id, classes, css, problems: sheet.problems.map((problem) => problem.message) };
}

/**
 * The classes of a CSS module that the program never names: `styles.button` and
 * `styles["is-active"]` name one. Any other use, e.g. `styles[kind]`, may name each of them.
 */
export function unusedClasses(program: ast.Program, local: string, module: StyleModule): string[] {
  const used = new Set<string>();
  let dynamic = false;
  const visit = (node: ast.Node): void => {
    if (node.kind === 'MemberExpression' && isLocal(node.object)) {
      used.add(node.property.name);

      return;
    }

    if (node.kind === 'IndexExpression' && isLocal(node.object)) {
      if (node.index.kind === 'StringLiteral') used.add(node.index.value);
      else dynamic = true;

      return;
    }

    if (isLocal(node)) dynamic = true;
    forEachChild(node, visit);
  };
  const isLocal = (node: ast.Node) => node.kind === 'Identifier' && node.name === local;

  for (const statement of program.body) {
    if (statement.kind !== 'ImportDeclaration') visit(statement);
  }

  return dynamic ? [] : [...module.classes.keys()].filter((name) => !used.has(name));
}
