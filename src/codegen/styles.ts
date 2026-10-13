import type * as ast from '../ast.ts';
import type { CssDeclaration } from '../css/parse.ts';
import { originOf } from '../decorator-copy.ts';
import {
  componentStyle,
  ownElements,
  scopedCss,
  styleBlocks,
  type ComponentStyle,
} from '../styles.ts';
import type { Source } from './reactive.ts';
import { RefEmitter } from './refs.ts';

/**
 * `style { ... }` of components and decorators. The elements of their own markup get the class of
 * the style; the module adds the CSS of every style whose elements it creates with `$$style`, at
 * its start; values from code are CSS variables, set on the element the component returns once
 * it is created and again when what they read changes.
 *
 * Inlined code is a copy: of a decorator for the components it is applied to, of a component of
 * another module. Copies are found by the nodes as written, `originOf`.
 */

/** The style of a component or a decorator as written. */
interface Owner {
  name: string;
  style: ComponentStyle;
}

/** A CSS variable of the component being written: its name and the declaration it comes from. */
interface StyleValue {
  variable: string;
  declaration: CssDeclaration;
  values: ast.Expression[];
}

export abstract class StyleEmitter extends RefEmitter {
  /** The styles by the elements and the `style` blocks of their own code; made on first use. */
  private owners: Map<ast.Node, Owner> | null = null;
  /** The styles whose elements the module creates, in the order of first use. */
  protected readonly usedStyles = new Set<Owner>();
  /** The CSS variables of the component being written, and whether its updates are added. */
  private styleValues: { result: string; values: StyleValue[]; registered: boolean } | null = null;

  /** The class of the style an element of markup belongs to, if its owner has one. */
  protected override scopeOf(node: ast.ElementExpression): string | null {
    const owner = this.ownersByNode().get(originOf(node));

    if (!owner) return null;
    this.usedStyles.add(owner);

    return owner.style.scope;
  }

  /** `$$style(id, css)` for every style the module uses. */
  protected styleRegistrations(): string[] {
    return [...this.usedStyles].map(({ style }) => {
      const css = scopedCss(style).replace(/[`\\]|\$\{/g, (match) => `\\${match}`);

      return `$$style(${JSON.stringify(style.scope)}, \`${css}\`);`;
    });
  }

  /** Writes the code of a component, whose result is `result`, with its CSS variables. */
  protected withStyles<T>(component: ast.ComponentDeclaration, result: string, emit: () => T): T {
    const saved = this.styleValues;
    const values = this.valuesOf(component);

    this.styleValues = values.length > 0 ? { result, values, registered: false } : null;
    try {
      return emit();
    } finally {
      this.styleValues = saved;
    }
  }

  /** Sets the CSS variables on the element the component created. */
  protected override setStyleValues(result: string): void {
    for (const value of this.styleValues?.values ?? []) this.line(this.setValue(result, value));
  }

  /** The updates of the CSS variables go with those of what they read. */
  protected override registerStyleValues(): void {
    const { reactive, styleValues } = this;

    if (!reactive || !styleValues || styleValues.registered) return;
    styleValues.registered = true;
    for (const value of styleValues.values) {
      const sources = new Set<Source>();

      for (const part of value.declaration.value) {
        if (typeof part !== 'number') continue;
        for (const source of reactive.dependencies(value.values[part]!)) sources.add(source);
      }

      if (sources.size > 0) reactive.depend(sources, this.setValue(styleValues.result, value));
    }
  }

  private setValue(result: string, { variable, declaration, values }: StyleValue): string {
    const { value } = declaration;
    const only = value.length === 1 && typeof value[0] === 'number' ? value[0] : null;
    const text =
      only !== null
        ? this.liveExpression(values[only]!)
        : `\`${value
            .map((part) =>
              typeof part === 'number'
                ? `\${${this.liveExpression(values[part]!)}}`
                : part.replace(/[`\\]|\$\{/g, (match) => `\\${match}`),
            )
            .join('')}\``;

    return `${result}.style.setProperty(${JSON.stringify(variable)}, ${text});`;
  }

  /**
   * The CSS variables of a component as it is inlined: its own `style` blocks and copies of those
   * of its decorators, whose values are renamed for it.
   */
  private valuesOf(component: ast.ComponentDeclaration): StyleValue[] {
    const groups = new Map<Owner, ast.StyleStatement[]>();

    for (const block of styleBlocks(component.body)) {
      const owner = this.ownersByNode().get(originOf(block));

      if (owner) groups.set(owner, [...(groups.get(owner) ?? []), block]);
    }

    return [...groups].flatMap(([owner, blocks]) => {
      const body: ast.BlockStatement = { kind: 'BlockStatement', body: blocks, start: 0, end: 0 };
      // The same text as the original: the same variables, with the values of this copy.
      const copy = componentStyle(owner.name, body)!;

      return [...copy.variables].map(([declaration, variable]) => ({
        variable,
        declaration,
        values: copy.values,
      }));
    });
  }

  private ownersByNode(): Map<ast.Node, Owner> {
    if (this.owners) return this.owners;

    const owners = new Map<ast.Node, Owner>();
    const add = (node: ast.ComponentDeclaration | ast.DecoratorDeclaration) => {
      const style = componentStyle(node.name.name, node.body);

      if (!style) return;

      const owner: Owner = { name: node.name.name, style };

      for (const element of ownElements(node.body)) owners.set(element, owner);
      for (const block of styleBlocks(node.body)) owners.set(block, owner);
    };

    for (const statement of this.program.body) {
      if (statement.kind === 'ComponentDeclaration' || statement.kind === 'DecoratorDeclaration') {
        add(statement);
      }
    }

    // The code of other modules that is inlined here, as written there.
    for (const source of [
      ...(this.options.decorators?.values() ?? []),
      ...(this.options.components?.values() ?? []),
    ]) {
      add(source.node);
      for (const node of source.inline?.components.values() ?? []) add(node);
      for (const decorator of source.inline?.decorators.values() ?? []) add(decorator.node);
    }

    this.owners = owners;

    return owners;
  }
}
