import type * as ast from '../ast.ts';
import { ComponentPropsEmitter } from './component-props.ts';
import type { Reactive } from './reactive.ts';
import { Block } from './reactive.ts';
import { ARROW, indentMore } from './syntax.ts';
import { inlinesUpdate, needed } from './updates.ts';
import { type EarlyReturns, type Ending, SETTERS } from './component-helpers.ts';

/** The markup a component returns, with early returns, update functions and setters of properties. */

export abstract class EarlyReturnEmitter extends ComponentPropsEmitter {
  /** Writes the code of a component with its own reactivity, apart from the enclosing one. */
  protected inComponent<T>(reactive: Reactive, mountNode: string | null, emit: () => T): T {
    const saved = {
      reactive: this.reactive,
      inHandler: this.inHandler,
      rendering: this.rendering,
      earlyReturns: this.earlyReturns,
      mountNode: this.mountNode,
    };
    this.reactive = reactive.sources.size > 0 ? reactive : null;
    this.inHandler = 0;
    this.rendering = 0;
    this.earlyReturns = null;
    this.mountNode = mountNode;
    try {
      return emit();
    } finally {
      this.reactive = saved.reactive;
      this.inHandler = saved.inHandler;
      this.rendering = saved.rendering;
      this.earlyReturns = saved.earlyReturns;
      this.mountNode = saved.mountNode;
    }
  }

  /**
   * After the markup of a component with `mount()` is created, before anything inserts it: its
   * first node. A fragment is empty once inserted, so its first child is taken now.
   */
  protected captureMountNode(result: string): void {
    if (!this.mountNode) return;
    this.line(`${this.mountNode} = ${result}?.nodeType === 11 ? ${result}.firstChild : ${result};`);
  }

  /** Declarations that every return needs, written before the statements of the body. */
  protected prepareEarlyReturns(
    result: string,
    reactive: Reactive,
    ending: Ending,
    label: string | null,
    component: ast.ComponentDeclaration,
  ): EarlyReturns {
    const id = this.nextId();
    const view = `$$view${id}`;
    let exit = `break ${label};`;
    let setter: string | null = null;
    if (ending.kind === 'function') {
      setter = ending.props.length > 0 ? `$$set${component.name.name}${id}` : null;
      exit = `return [${result}${setter ? `, ${setter}` : ''}];`;
    } else if (ending.setters.size > 0) {
      this.line(`${SETTERS}${result}${SETTERS}`);
    }
    if (reactive.sources.size > 0) this.line(`let ${view};`);
    return { fn: this.fn, result, reactive, view, exit, setter };
  }

  /** The markup of one `return`: a block with its own update, which `view` keeps. */
  protected returnedMarkup(value: ast.Expression, early: EarlyReturns): void {
    const { result, reactive, view } = early;
    if (reactive.sources.size === 0) {
      if (value.kind === 'ElementExpression' && !this.componentOf(value)) {
        this.build(value, result, null);
      } else {
        this.line(`${result} = ${this.expression(value, ARROW)};`);
      }
      this.captureMountNode(result);
      return;
    }
    const block = new Block(reactive);
    const root =
      value.kind === 'ElementExpression'
        ? this.create(value, block)
        : this.expression(value, ARROW);
    if (block.statements.length > 0) {
      const body = this.block(() => {
        for (const statement of block.statements) this.line(indentMore(statement));
      });
      this.line(`${view} = () => ${body};`);
      reactive.depend(block.sources, `${view}?.();`);
    }
    this.line(`${result} = ${root};`);
    this.captureMountNode(result);
  }

  /** The last `return` of a component with early returns, then the updates and the setters. */
  protected lastReturn(value: ast.Expression, ending: Ending, early: EarlyReturns): void {
    const { result, reactive } = early;
    this.returnedMarkup(value, early);
    const functions = this.updateFunctions(result, reactive);
    if (ending.kind === 'inline') {
      // An early return leaves the block, so the setters are assigned at its top.
      const texts = [...ending.setters].map(
        ([prop, setter]) => `${setter} = ($$${prop}) => ${this.setterBody([prop], reactive)};`,
      );
      if (texts.length > 0) this.pendingSetters.set(result, texts);
      return;
    }
    if (early.setter) {
      this.blankLine();
      const params = this.parameters(ending.props, '$$');
      const names = ending.props.map((param) => param.name.name);
      this.line(`function ${early.setter}(${params}) ${this.setterBody(names, reactive)}`);
    } else if (functions > 0) {
      this.blankLine();
    }
    this.line(early.exit);
  }

  /** Puts the setters of an inlined component with early returns at the top of its block. */
  protected placeSetters(code: string, result: string): string {
    const texts = this.pendingSetters.get(result);
    const marker = `${SETTERS}${result}${SETTERS}`;
    if (!code.includes(marker)) return code;
    this.pendingSetters.delete(result);
    return code.replace(
      new RegExp(`^([ \\t]*)${marker.replace(/\$/g, '\\$')}\n`, 'm'),
      (_, indent: string) => (texts ?? []).map((text) => `${indent}${text}\n`).join(''),
    );
  }

  /** Functions that update the markup after changes of state; returns how many were written. */
  protected updateFunctions(result: string, reactive: Reactive): number {
    let functions = 0;
    for (const source of reactive.sources.values()) {
      const called = source.writes.some((write) => needed(source, write).length > 0);
      if (source.kind !== 'state' || !called || inlinesUpdate(source)) continue;
      const body = this.block(() => {
        // A function of the body may change the state while the markup is being created.
        if (source.writes.some((write) => write.early)) this.line(`if (!${result}) return;`);
        for (const dependent of source.dependents) this.line(indentMore(dependent));
      });
      this.blankLine();
      this.line(`function ${source.update}() ${body}`);
      functions++;
    }
    return functions;
  }

  /** The markup a component returns, then the functions that update it. */
  protected markup(
    value: ast.Expression,
    result: string,
    reactive: Reactive,
    ending: Ending,
  ): void {
    if (reactive.sources.size === 0) {
      if (value.kind === 'ElementExpression' && !this.componentOf(value)) {
        this.build(value, result, null);
      } else {
        this.line(`${result} = ${this.expression(value, ARROW)};`);
      }
      this.captureMountNode(result);
      if (ending.kind === 'function') this.line(`return [${result}];`);
      return;
    }
    const root =
      value.kind === 'ElementExpression'
        ? this.create(value, reactive)
        : this.expression(value, ARROW);

    let functions = 0;
    const setters = ending.kind === 'inline' ? ending.setters : new Map<string, string>();
    for (const [prop, setter] of setters) {
      const source = reactive.sources.get(prop)!;
      const param = `$$${prop}`;
      const body = this.block(() => {
        this.line(`${this.name(prop)} = ${param};`);
        for (const dependent of source.dependents) this.line(indentMore(dependent));
      });
      this.blankLine();
      this.line(`${setter} = (${param}) => ${body};`);
      functions++;
    }
    functions += this.updateFunctions(result, reactive);
    if (functions > 0) this.blankLine();
    this.line(`${result} = ${root};`);
    this.captureMountNode(result);
    if (ending.kind === 'function') this.functionResult(result, reactive, ending.props);
  }
}
