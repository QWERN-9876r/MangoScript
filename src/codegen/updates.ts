import type * as ast from '../ast.ts';
import { widenLiterals, type Type } from '../checker/types.ts';
import type { Reactive, Source, Write } from './reactive.ts';
import { StatementEmitter } from './statements.ts';
import { ARROW } from './syntax.ts';

/**
 * Updates after changes of component state. Each state variable gets an update function; every
 * place that changes the variable calls it. Those places are written before it is known what the
 * update needs, so they get a marker that is replaced at the end of the component (see
 * resolveMarkers): by the call, by the only update statement, or by nothing.
 */
export abstract class UpdateEmitter extends StatementEmitter {
  /** The component whose code is being written, if it has state or reactive properties. */
  protected reactive: Reactive | null = null;
  /** Inside event handlers, which cannot run before the markup exists. */
  protected inHandler = 0;
  /**
   * Inside code that runs while live markup is created or updated: its expressions, the functions
   * they call and the callbacks they pass (`items.map(item => ...)`). Changes there do not update
   * the markup, which would update it again; code that runs later (handlers) is not included.
   */
  protected rendering = 0;

  /** After a statement that changes state, the update of what depends on it. */
  protected override statement(node: ast.Statement): void {
    const { reactive } = this;
    if (reactive && this.fn === reactive.setup && reactive.declaresRenderFunction(node)) {
      this.withRendering(this.rendering + 1, () => super.statement(node));
      return;
    }
    const written = this.changedBy(node);
    if (written.length === 0) {
      super.statement(node);
      return;
    }
    switch (node.kind) {
      case 'ReturnStatement':
      case 'ThrowStatement': {
        // The update goes between computing the value and leaving the function.
        const values = node.kind === 'ThrowStatement' ? [node.argument] : node.values;
        const temp = this.temp();
        this.withHoisting(true, () => {
          const rendered = values.map((value) => this.expression(value, ARROW));
          const value = rendered.length === 1 ? rendered[0]! : `[${rendered.join(', ')}]`;
          this.line(`const ${temp} = ${value};`);
        });
        this.updates(written);
        this.line(`${node.kind === 'ThrowStatement' ? 'throw' : 'return'} ${temp};`);
        return;
      }
      case 'IfStatement':
      case 'ForStatement':
      case 'ForInStatement':
      case 'SwitchStatement':
        // The change is in a condition: update at the start of every branch, before anything in
        // it can leave the function, and after the statement.
        super.statement(withFirst(node, (position) => this.markers(written, position)));
        this.updates(written);
        return;
      default:
        super.statement(node);
        this.updates(written);
    }
  }

  protected override changesState(body: ast.Expression): boolean {
    return this.changedBy(body).length > 0;
  }

  protected withRendering<T>(rendering: number, emit: () => T): T {
    const saved = this.rendering;
    this.rendering = rendering;
    try {
      return emit();
    } finally {
      this.rendering = saved;
    }
  }

  /** Records a place that changes a source and returns its marker; see resolveMarkers. */
  protected write(source: Source, skip: number | null = null): string {
    source.writes.push({ early: this.inHandler === 0, skip });
    return `\uE000${source.id}${skip === null ? '' : `:${skip}`}\uE001`;
  }

  /** The type from the checker; literal types count as their base types here (`"all"` → string). */
  protected typeOf(node: ast.Expression): Type | undefined {
    const type = this.options.types?.get(node);
    return type && widenLiterals(type);
  }

  /** State that a statement changes, when it runs after the component's markup is created. */
  private changedBy(node: ast.Node): Source[] {
    const { reactive } = this;
    if (!reactive || this.fn === reactive.setup || this.rendering > 0) return [];
    return [...reactive.writtenBy(node, (expression) => this.typeOf(expression))];
  }

  private updates(sources: readonly Source[]): void {
    for (const source of sources) this.line(`${this.write(source)};`);
  }

  /** Marker statements for the start of a branch, at `position` in the source. */
  private markers(sources: readonly Source[], position: number): ast.Statement[] {
    return sources.map((source) => {
      const expression: ast.Identifier = {
        kind: 'Identifier',
        name: this.write(source),
        start: position,
        end: position,
      };
      return { kind: 'ExpressionStatement', expression, start: position, end: position };
    });
  }
}

/**
 * Replaces the markers of a component's sources: by the call of the update function, by the only
 * update statement, or by nothing when no markup depends on the source.
 */
export function resolveMarkers(block: string, reactive: Reactive): string {
  const sources = new Map<number, Source>();
  for (const source of reactive.sources.values()) sources.set(source.id, source);
  return block.replace(
    /^([ \t]*)\uE000(\d+)(?::(\d+))?\uE001;\n/gm,
    (line, indent: string, id: string, skip: string | undefined) => {
      const source = sources.get(Number(id));
      if (!source) return line;
      const dependents = needed(source, { early: false, skip: skip ? Number(skip) : null });
      if (dependents.length === 0) return '';
      const text = inlinesUpdate(source) ? dependents[0]! : `${source.update}();`;
      return `${indent}${text}\n`;
    },
  );
}

/** The update statements that a place changing the source needs. */
export function needed(source: Source, write: Write): string[] {
  return source.dependents.filter((_, i) => i !== write.skip);
}

/** One place changes the source, after the markup exists, and needs one update statement. */
export function inlinesUpdate(source: Source): boolean {
  const [write] = source.writes;
  if (source.writes.length !== 1 || write!.early) return false;
  const dependents = needed(source, write!);
  return dependents.length === 1 && !dependents[0]!.includes('\n');
}

/**
 * A copy of an if/for/switch statement with statements added at the start of every branch or
 * loop body; `first` gets the position where they go.
 */
function withFirst(
  node: ast.IfStatement | ast.ForStatement | ast.ForInStatement | ast.SwitchStatement,
  first: (position: number) => ast.Statement[],
): ast.Statement {
  const prepend = (body: readonly ast.Statement[], end: number) => [
    ...first(body[0]?.start ?? end),
    ...body,
  ];
  const block = (node: ast.BlockStatement): ast.BlockStatement => ({
    ...node,
    body: prepend(node.body, node.end - 1),
  });
  switch (node.kind) {
    case 'IfStatement': {
      const { alternate } = node;
      return {
        ...node,
        consequent: block(node.consequent),
        alternate:
          alternate === null
            ? null
            : alternate.kind === 'IfStatement'
              ? (withFirst(alternate, first) as ast.IfStatement)
              : block(alternate),
      };
    }
    case 'ForStatement':
    case 'ForInStatement':
      return { ...node, body: block(node.body) };
    case 'SwitchStatement':
      return {
        ...node,
        cases: node.cases.map((switchCase) => ({
          ...switchCase,
          body: prepend(switchCase.body, switchCase.end),
        })),
      };
  }
}
