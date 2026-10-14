import type * as ast from '../ast.ts';
import { isWrappedContent } from '../decorators.ts';
import { ComponentValueEmitter } from './component-values.ts';
import type { Live, Reactive } from './reactive.ts';
import { effectReads } from './mutations.ts';
import { Block, updatesOf } from './reactive.ts';
import { ARROW, indentMore } from './syntax.ts';
import { inlinesUpdate, needed } from './updates.ts';
import { type EarlyReturns, type Ending, SETTERS } from './component-helpers.ts';

/** The markup a component returns, with early returns, update functions and setters of properties. */

/** `effect { ... }` of the component being written: its function and the list of its cleanups. */
interface Effect {
  name: string;
  node: ast.EffectStatement;
  cleanups: string | null;
}

export abstract class EarlyReturnEmitter extends ComponentValueEmitter {
  /** The CSS variables of the component's style, once its markup exists; by StyleEmitter. */
  protected abstract setStyleValues(result: string): void;

  /** Their updates, with those of the effects. */
  protected abstract registerStyleValues(): void;

  /**
   * The effects of the component being written. One after an early return may not be created, so
   * it does not run again on changes, like the markup there.
   */
  private effects: (Effect & { live: boolean; registered: boolean })[] = [];
  /** Whether an early return of the component has been written. */
  protected returnedEarly = false;

  /**
   * The updates of the markup a component gives to the wrappers of its decorators, after an early
   * return: they go into the view of the `return` that follows, with the wrappers' markup.
   */
  private wrapped: Block | null = null;

  /** Writes the code of a component with its own reactivity, apart from the enclosing one. */
  protected inComponent<T>(reactive: Reactive, mountNode: string | null, emit: () => T): T {
    const saved = {
      reactive: this.reactive,
      inHandler: this.inHandler,
      rendering: this.rendering,
      earlyReturns: this.earlyReturns,
      mountNode: this.mountNode,
      wrapped: this.wrapped,
      effects: this.effects,
      returnedEarly: this.returnedEarly,
    };

    this.reactive = reactive.sources.size > 0 ? reactive : null;
    this.inHandler = 0;
    this.rendering = 0;
    this.earlyReturns = null;
    this.mountNode = mountNode;
    this.wrapped = null;
    this.effects = [];
    this.returnedEarly = false;
    try {
      return emit();
    } finally {
      this.reactive = saved.reactive;
      this.inHandler = saved.inHandler;
      this.rendering = saved.rendering;
      this.earlyReturns = saved.earlyReturns;
      this.mountNode = saved.mountNode;
      this.wrapped = saved.wrapped;
      this.effects = saved.effects;
      this.returnedEarly = saved.returnedEarly;
    }
  }

  protected addEffect(effect: Effect): void {
    this.effects.push({ ...effect, live: !this.returnedEarly, registered: false });
  }

  /**
   * An effect runs again after the updates of what it reads, so it is added after the markup, when
   * the update functions are not written yet.
   */
  protected registerEffects(): void {
    const { reactive } = this;

    if (!reactive) return;
    this.registerStyleValues();
    for (const effect of this.effects) {
      if (effect.registered || !effect.live) continue;
      effect.registered = true;
      reactive.depend(reactive.dependencies(effect.node.body, effectReads), `${effect.name}();`);
    }
  }

  /** Markup for a wrapper is live like returned markup, also where the body may have returned. */
  protected override declaredLive(node: ast.ElementExpression): Live | null {
    const early = this.earlyReturns;

    if (!early || !this.reactive || !isWrappedContent(node) || this.reactive.topLevel.has(node)) {
      return super.declaredLive(node);
    }

    return (this.wrapped ??= new Block(early.reactive));
  }

  /**
   * After the markup of a component is created, before anything inserts it: the first node for
   * `mount()` (a fragment is empty once inserted, so its first child is taken now), the CSS
   * variables of its style, and the first run of the effects, whose cleanups also run when the
   * component is removed.
   */
  protected markupCreated(result: string): void {
    if (this.mountNode) {
      this.line(
        `${this.mountNode} = ${result}?.nodeType === 11 ? ${result}.firstChild : ${result};`,
      );
    }

    this.setStyleValues(result);

    for (const effect of this.effects) {
      this.line(`${effect.name}();`);
      if (effect.cleanups === null) continue;
      this.helpers.add('owner');
      this.line(`$$onRemove(() => $$runDeferred(${effect.cleanups}.splice(0)));`);
    }
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
      if (value.kind === 'ElementExpression' && this.isElement(value)) {
        this.build(value, result, null);
      } else {
        this.line(`${result} = ${this.expression(value, ARROW)};`);
      }

      this.markupCreated(result);

      return;
    }

    // A wrapper returns once, so what was given to it updates in this view.
    const block = this.wrapped ?? new Block(reactive);

    this.wrapped = null;

    const root =
      value.kind === 'ElementExpression'
        ? this.create(value, block)
        : this.expression(value, ARROW);

    this.registerEffects();

    if (block.statements.length > 0) {
      const body = this.block(() => {
        for (const statement of block.statements) this.line(indentMore(statement));
      });

      this.line(`${view} = () => ${body};`);
      reactive.depend(block.sources, `${view}?.();`);
    }

    this.line(`${result} = ${root};`);
    this.markupCreated(result);
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
        // Derived values are computed again even before the markup exists, which a function of
        // the body may change the state before.
        for (const computation of source.computations) this.line(indentMore(computation));
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
      if (value.kind === 'ElementExpression' && this.isElement(value)) {
        this.build(value, result, null);
      } else {
        this.line(`${result} = ${this.expression(value, ARROW)};`);
      }

      this.markupCreated(result);
      if (ending.kind === 'function') this.line(`return [${result}];`);

      return;
    }

    const root =
      value.kind === 'ElementExpression'
        ? this.create(value, reactive)
        : this.expression(value, ARROW);

    this.registerEffects();

    let functions = 0;
    const setters = ending.kind === 'inline' ? ending.setters : new Map<string, string>();

    for (const [prop, setter] of setters) {
      const source = reactive.sources.get(prop)!;
      const param = `$$${prop}`;
      const body = this.block(() => {
        this.line(`${this.name(prop)} = ${param};`);
        for (const dependent of updatesOf(source)) this.line(indentMore(dependent));
      });

      this.blankLine();
      this.line(`${setter} = (${param}) => ${body};`);
      functions++;
    }

    functions += this.updateFunctions(result, reactive);
    if (functions > 0) this.blankLine();
    this.line(`${result} = ${root};`);
    this.markupCreated(result);
    if (ending.kind === 'function') this.functionResult(result, reactive, ending.props);
  }
}
