import type * as ast from '../ast.ts';
import { declarationsOf } from './analysis.ts';
import { ElementEmitter, type ControlStatement } from './elements.ts';
import { Block, type Live, type Source } from './reactive.ts';
import { CONDITIONAL, indentMore, upperFirst } from './syntax.ts';

/**
 * `{if ...}`, `{switch ...}` and `{for ...}` in live markup that depend on state. Markup that does
 * not change compiles to plain control flow (see ElementEmitter.children); here helpers keep the
 * content between markers instead, and each block is a function that creates its content and
 * returns its update.
 */
export abstract class ControlFlowEmitter extends ElementEmitter {
  /** Writes the code that creates the content and returns what to append; see the class. */
  protected override liveControl(
    statement: ControlStatement,
    live: Live,
    sources: ReadonlySet<Source>,
  ): string {
    const id = this.nextId();
    const kind =
      statement.kind === 'IfStatement'
        ? 'if'
        : statement.kind === 'SwitchStatement'
          ? 'switch'
          : 'for';
    const name = `$$${kind}${id}`;
    const update = `$$update${upperFirst(kind)}${id}`;
    let call: string;

    switch (statement.kind) {
      case 'IfStatement':
      case 'SwitchStatement': {
        const [choose, blocks] =
          statement.kind === 'IfStatement'
            ? this.ifBranches(statement, live)
            : this.switchBranches(statement, live);

        this.helpers.add('branches');
        call = `$$branches(${choose}, [${blocks.join(', ')}])`;
        break;
      }

      case 'ForInStatement': {
        this.helpers.add('list');

        const items = this.liveFunction(statement.iterable);

        call = `$$list(${items}, ${this.blockCreator(statement.body.body, live, statement)})`;
        break;
      }

      case 'ForStatement':
        // Without items to find the blocks by, the loop runs again and creates new content.
        this.helpers.add('content');
        call = `$$content(${this.loopContent(statement)})`;
        break;
    }

    this.line(`const [${name}, ${update}] = ${call};`);
    live.depend(sources, `${update}();`);

    return name;
  }

  /** The choice of an if/else chain, `() => a ? 0 : b ? 1 : -1`, and its blocks. */
  private ifBranches(node: ast.IfStatement, live: Live): [string, string[]] {
    const conditions: string[] = [];
    const blocks: string[] = [];
    let current: ast.IfStatement | ast.BlockStatement | null = node;

    while (current?.kind === 'IfStatement') {
      conditions.push(this.liveExpression(current.condition, CONDITIONAL + 1));
      blocks.push(this.blockCreator(current.consequent.body, live));
      current = current.alternate;
    }

    if (current) blocks.push(this.blockCreator(current.body, live));

    let choose = current ? String(conditions.length) : '-1';

    for (let i = conditions.length - 1; i >= 0; i--) choose = `${conditions[i]} ? ${i} : ${choose}`;

    return [`() => ${choose}`, blocks];
  }

  /** The choice of a switch: the same switch, returning the number of the case. */
  private switchBranches(node: ast.SwitchStatement, live: Live): [string, string[]] {
    const blocks = node.cases.map((switchCase) => this.blockCreator(switchCase.body, live));
    const choice: ast.SwitchStatement = {
      ...node,
      cases: node.cases.map((switchCase, i) => ({
        ...switchCase,
        body: [returnNumber(i, switchCase)],
      })),
    };
    const hasDefault = node.cases.some((switchCase) => switchCase.tests.length === 0);
    const body = this.withFunction('none', [], () =>
      this.withRendering(this.rendering + 1, () =>
        this.block(() => {
          this.statement(choice);
          if (!hasDefault) this.line('return -1;');
        }),
      ),
    );

    return [`() => ${body}`, blocks];
  }

  /**
   * The function that creates a block of markup control flow:
   * `(item, index) => { ...; return [fragment, update]; }`. Parts of the block that depend on
   * state go into its update.
   */
  private blockCreator(
    statements: readonly ast.Statement[],
    parent: Live,
    loop?: ast.ForInStatement,
  ): string {
    const block = new Block(parent);
    const params = loop ? [loop.value, ...(loop.key ? [loop.key] : [])].map(parameter) : [];

    return this.withFunction('none', params, () =>
      this.withRendering(this.rendering + 1, () => {
        const paramList = this.params(params);
        const fragment = `$$block${this.nextId()}`;
        const body = this.block(() =>
          this.withScope(declarationsOf(statements), () => {
            this.line(`const ${fragment} = document.createDocumentFragment();`);
            this.children(fragment, statements, block);

            // The block of an item that stays gets the item's new position.
            const key = loop?.key && loop.key.name !== '_' ? this.name(loop.key.name) : null;
            const updates = [...(key ? [`${key} = $$index;`] : []), ...block.statements];

            if (updates.length === 0) {
              this.line(`return [${fragment}];`);

              return;
            }

            const update = this.block(() => {
              for (const statement of updates) this.line(indentMore(statement));
            });

            this.line(`return [${fragment}, (${key ? '$$index' : ''}) => ${update}];`);
          }),
        );

        return `(${paramList}) => ${body}`;
      }),
    );
  }

  /** A classic `for` loop in live markup: a function that runs it and returns the content. */
  private loopContent(statement: ast.ForStatement): string {
    return this.withFunction('none', [], () =>
      this.withRendering(this.rendering + 1, () => {
        const fragment = `$$block${this.nextId()}`;
        const body = this.block(() => {
          this.line(`const ${fragment} = document.createDocumentFragment();`);
          this.withContentTarget(fragment, () => this.statement(statement));
          this.line(`return ${fragment};`);
        });

        return `() => ${body}`;
      }),
    );
  }
}

/** `return 2` for the choice of a switch case. */
function returnNumber(value: number, at: ast.NodeBase): ast.ReturnStatement {
  const number: ast.NumberLiteral = {
    kind: 'NumberLiteral',
    value,
    raw: String(value),
    start: at.start,
    end: at.start,
  };

  return { kind: 'ReturnStatement', values: [number], start: at.start, end: at.start };
}

/** A loop variable as a parameter of the function that creates the loop's blocks. */
function parameter(name: ast.Identifier): ast.Parameter {
  return {
    kind: 'Parameter',
    name,
    type: null,
    defaultValue: null,
    start: name.start,
    end: name.end,
  };
}
