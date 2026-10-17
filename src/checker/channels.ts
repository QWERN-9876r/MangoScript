import type * as ast from '../ast.ts';
import { assignedNames } from '../names.ts';
import { chanDirection, chanOf, elementOf, isChan } from './channel.ts';
import { GoroutineChecker } from './goroutines.ts';
import { isUntyped } from './helpers.ts';
import { isPromise } from './promise.ts';
import { BUFFERS } from './transfer.ts';
import {
  ANY,
  BOOL,
  ERROR,
  instantiate,
  isNullable,
  nonNull,
  NUMBER,
  type ObjectType,
  typeToString,
  type Type,
  typedArrayOf,
  UNKNOWN,
} from './types.ts';

// Channels: `chan<number>(10)` makes one, `ch <- v` sends a value, `<-ch` receives one (in
// operators.ts), `for v in ch` receives them until it is closed (in control-flow.ts), and
// `select` waits for the first of several. `transfer(x)` moves a buffer to another thread.
// `chan(stream)` receives the chunks of a ReadableStream, and `stream(ch)` reads a channel.

/** What `transfer(x)` moves: a buffer, or a view whose buffer moves. */
const MOVABLE: ReadonlySet<string> = new Set(BUFFERS);

function typeName(type: Type): string | null {
  if (type.kind === 'class') return type.info.name;
  if (type.kind === 'object') return type.instanceOf?.template.name ?? type.name;

  return null;
}

export abstract class ChannelChecker extends GoroutineChecker {
  protected override checkChan(node: ast.ChanExpression): Type {
    const element = this.resolveType(node.element);

    if (node.size) this.expectAssignable(this.checkValue(node.size, NUMBER), NUMBER, node.size);

    return chanOf(element);
  }

  // `chan(res.body, 4)`: the channel of the chunks and the one of the error of the stream. A null
  // stream, such as the body of a response without one, gives a closed channel.
  protected override checkStreamChan(node: ast.StreamChanExpression): Type {
    const type = this.checkValue(node.stream);
    const stream = isNullable(type) ? nonNull(type) : type;
    let element: Type = ANY;

    if (stream.kind === 'object' && typeName(stream) === 'ReadableStream') {
      element = stream.instanceOf?.args[0] ?? ANY;

      // The bytes of a body are a Uint8Array<ArrayBuffer>, and a channel takes only its own type:
      // its values are `[]byte`.
      const typed = typedArrayOf(element);

      if (typed !== null) element = this.typedArray(typed);
    } else if (!isUntyped(stream)) {
      this.error(
        `chan(...) takes a ReadableStream, not ${typeToString(type)}; a channel of values is made as chan<T>(size), e.g. chan<number>(10)`,
        node.stream,
      );
      if (node.size) this.checkValue(node.size);

      // `ch = chan(10)` meant `chan<number>(10)`: one error is enough.
      return UNKNOWN;
    }

    if (node.size) this.expectAssignable(this.checkValue(node.size, NUMBER), NUMBER, node.size);

    return { kind: 'tuple', types: [chanOf(element), chanOf(ERROR, 'receive')] };
  }

  protected override checkSend(node: ast.SendStatement): void {
    const nullChannel = this.inSelectCase;

    this.inSelectCase = false;

    const type = this.checkValue(node.channel);
    const channel = nullChannel && isNullable(type) ? nonNull(type) : type;

    if (!isChan(channel)) {
      if (!isUntyped(channel)) {
        this.error(`"<-" sends to a channel, not to ${typeToString(channel)}`, node.channel);
      }

      this.checkValue(node.value);

      return;
    }

    const element = elementOf(channel);

    if (chanDirection(channel) === 'receive') {
      this.error(
        `"<-" cannot send to ${typeToString(channel)}: it only receives; send to a "chan T" or a "chan<- T"`,
        node.channel,
      );
    }

    this.expectAssignable(this.checkValue(node.value, element), element, node.value);
  }

  // `close(ch)` takes any channel, but a channel is closed by its sender, so not a `<-chan T`;
  // `cancel(task)` takes the Promise of `go`; `transfer(x)` takes what postMessage can move: a
  // buffer, or a view of one.
  protected override checkCall(
    node: ast.CallExpression,
    callee: Type,
    expected: Type | null = null,
  ): Type {
    const result = super.checkCall(node, callee, expected);
    const [argument] = node.arguments;
    const type = argument && argument.kind !== 'SpreadElement' && this.checkedTypes.get(argument);
    const builtin =
      node.callee.kind === 'Identifier' &&
      this.lookupValue(node.callee.name) === this.globals.values.get(node.callee.name)
        ? node.callee.name
        : null;

    if (!type || !argument) return result;
    if (builtin === 'close' && isChan(type) && chanDirection(type) === 'receive') {
      this.error(
        `cannot close ${typeToString(type)}: it only receives, and a channel is closed by its sender`,
        argument,
      );
    }

    if (builtin === 'stream' && isChan(type)) return this.streamOf(type, argument);

    if (builtin === 'cancel' && !isUntyped(type) && !isPromise(type)) {
      this.error(
        `cancel() stops a goroutine: give it the Promise of "go", not ${typeToString(type)}, e.g. "const task = go work(x)" and "cancel(task)"`,
        argument,
      );
    }

    if (builtin === 'transfer' && !isUntyped(type) && !MOVABLE.has(typeName(type) ?? '')) {
      this.error(
        `transfer() moves an ArrayBuffer or a typed array to another thread, not ${typeToString(type)}; other values are copied`,
        argument,
      );
    }

    return result;
  }

  /** `stream(ch)`: a ReadableStream of the values of the channel, from the library if it has one. */
  private streamOf(channel: ObjectType, argument: ast.Expression): Type {
    if (chanDirection(channel) === 'send') {
      this.error(
        `stream() reads a channel, and ${typeToString(channel)} only sends; give it a "chan T" or a "<-chan T"`,
        argument,
      );
    }

    const template = this.options.library?.type('ReadableStream');

    return template?.kind === 'object' && template.typeParams?.length === 1
      ? instantiate(template, [elementOf(channel)])
      : ANY;
  }

  protected override checkSelect(node: ast.SelectStatement): void {
    this.dropNarrowing(assignedNames(node));

    const entry = this.flow;

    for (const { names, operation, body } of node.cases) {
      this.flow = new Map(entry);
      this.withScope(() => {
        // A null channel turns its case off, as a nil channel does in Go.
        this.inSelectCase = operation !== null;
        if (operation?.kind === 'SendStatement') {
          this.checkSend(operation);
        } else if (operation) {
          // `case v, ok = <-ch:` declares the variables of the case.
          const value = this.checkExpression(operation, null);
          const [name, ok] = names;

          if (name) this.declareValue(name, 'const', value);
          if (ok) this.declareValue(ok, 'const', BOOL);
        }

        this.inSelectCase = false;
        this.checkBlock(body);
      });
    }

    this.flow = entry;
  }
}
