import type * as ast from '../ast.ts';
import { assignedNames } from '../names.ts';
import { BytesChecker } from './bytes.ts';
import { chanDirection, elementOf, isChan } from './channel.ts';
import { isMap, loopEntry } from './iterables.ts';
import {
  ANY,
  isNullable,
  NUMBER,
  STRING,
  typeToString,
  UNKNOWN,
  type FunctionType,
  type Type,
} from './types.ts';

// `for ... in`: over arrays, strings, the iterables of the lib files (a Map gives its keys and
// values), channels, which wait for their values, and iterators, `func(yield func(T) bool)`.

export abstract class LoopChecker extends BytesChecker {
  protected override checkForIn(node: ast.ForInStatement): void {
    const iterable = this.checkValue(node.iterable);
    let value: Type = UNKNOWN;
    let key: Type = NUMBER;

    if (isNullable(iterable)) {
      this.nullError(node.iterable);
    } else if (iterable.kind === 'array') {
      value = iterable.element;
    } else if (iterable.kind === 'object' && iterable.iterates) {
      // A Map gives its keys and values; one variable gets the values, as with an array.
      const entry = loopEntry(iterable);

      value = isMap(iterable) && entry ? entry[1] : iterable.iterates;
      if (entry) key = entry[0];
      else if (node.key) {
        this.error(
          `${typeToString(iterable)} has no keys: loop over its values, e.g. "for value in items"`,
          node.key,
        );
      }
    } else if (iterable.kind === 'function' && iterable.iterator) {
      [key, value] = this.yielded(iterable, node);
    } else if (isChan(iterable)) {
      // Each value waits for the channel, until it is closed.
      value = elementOf(iterable);
      if (chanDirection(iterable) === 'send') {
        this.error(
          `"for ... in" cannot receive from ${typeToString(iterable)}: it only sends; receive from a "chan T" or a "<-chan T"`,
          node.iterable,
        );
      }

      if (this.fn && !this.fn.isAsync) {
        this.error(
          '"for ... in" a channel waits for its values, so it is allowed only in async functions and at the top level of a module',
          node.iterable,
        );
      }

      if (node.key) this.error('a channel has no keys: write "for value in ch"', node.key);
    } else if (iterable.kind === 'string') {
      value = STRING;
    } else if (iterable.kind === 'any') {
      value = ANY;
      key = ANY;
    } else if (iterable.kind === 'function') {
      this.error(
        `cannot iterate over ${typeToString(iterable)}: an iterator names its parameter yield, e.g. func(yield func(number) bool)`,
        node.iterable,
      );
    } else if (iterable.kind !== 'unknown') {
      this.error(`cannot iterate over ${typeToString(iterable)}`, node.iterable);
    }

    this.withScope(() => {
      if (node.key) this.declareValue(node.key, 'loop', key);
      this.declareValue(node.value, 'loop', value);
      this.dropNarrowing(assignedNames(node.body));

      const entry = this.flow;

      this.flow = new Map(entry);
      this.checkBlock(node.body.body);
      this.flow = entry;
    });
  }

  /**
   * The key and the value of a loop over an iterator: what its `yield` takes. Of two, one variable
   * gets the second, as with a Map; of one, there is no key.
   */
  private yielded(iterator: FunctionType, node: ast.ForInStatement): [Type, Type] {
    const yieldType = iterator.params[0];
    const taken = yieldType?.kind === 'function' ? yieldType.params : [];

    if (taken.length === 2) return [taken[0]!, taken[1]!];
    if (node.key) {
      this.error(
        `${typeToString(iterator)} yields one value, without a key: write "for value in ..."`,
        node.key,
      );
    }

    return [UNKNOWN, taken[0] ?? UNKNOWN];
  }
}
