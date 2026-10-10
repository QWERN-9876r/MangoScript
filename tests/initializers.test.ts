import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { parse } from '../src/parser/parser.ts';
import { runWithDom } from './fake-dom.ts';

// A variable used in its own initializer: in functions there, which run after it, as in JS; not
// directly, before it has a value.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  expect(diagnostics).toEqual([]);

  return check(program).diagnostics.map((d) => d.message);
}

// A timer without the standard library: its type is known only from `every`.
const TIMER = `interface Timer { stop func() }
func every(ms number, tick func()) Timer { return { stop: () => {} } }
`;

describe('variables in their own initializer', () => {
  it.each([
    ['a callback, at the top level', `${TIMER}const timer = every(10, () => timer.stop())`],
    [
      'a callback, in a function',
      `${TIMER}func start() {\n    const timer = every(10, () => timer.stop())\n}`,
    ],
    [
      'a func literal',
      'const fact = func(n number) number {\n    return n <= 1 ? 1 : n * fact(n - 1)\n}',
    ],
    [
      'an arrow function with a written type',
      'const fib func(number) number = n => n < 2 ? n : fib(n - 1) + fib(n - 2)',
    ],
    [
      'nested initializers',
      `${TIMER}const outer = every(10, () => {
    const inner = every(20, () => {
        inner.stop()
        outer.stop()
    })
})`,
    ],
    [
      'this in a method',
      `${TIMER}class Ticker {
    count number = 0
    start() {
        const timer = every(10, () => {
            this.count++
            timer.stop()
        })
    }
}`,
    ],
    [
      'state in a component',
      `${TIMER}comp Clock() {
    state ticks = 0
    mount() {
        const timer = every(1000, () => {
            ticks++
            if ticks > 3 { timer.stop() }
        })
        return () => timer.stop()
    }
    return <p>{ticks}</p>
}`,
    ],
    [
      'narrowing kept in the callback',
      `${TIMER}func f(name ?string) {
    if name == null { return }
    const timer = every(10, () => {
        console.log(name.length)
        timer.stop()
    })
}`,
    ],
  ])('accepts %s', (_, source) => {
    expect(errors(source)).toEqual([]);
  });

  it('checks the body of a callback with the type of the variable', () => {
    expect(errors(`${TIMER}const timer = every(10, () => timer.start())`)).toEqual([
      'Timer has no member "start"',
    ]);
  });

  it.each([
    ['const x number = x + 1', '"x" is used in its own initializer, before it has a value'],
    [
      'func f() {\n    const x number = x + 1\n}',
      '"x" is used in its own initializer, before it has a value',
    ],
    [
      'const x = 1\nfunc f() {\n    const x = x + 1\n}',
      '"x" here is the new variable, which has no value yet; give it another name to use the outer "x"',
    ],
    [
      'const f = () => f()',
      '"f" is used in its own initializer: give it a type, e.g. const f func() = ...',
    ],
    [
      'const xs = [1, 2].map(x => xs.length)',
      '"xs" is used in its own initializer: write its type after the name',
    ],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });

  it('runs recursive function literals', () => {
    expect(
      runWithDom(`const fact = func(n number) number {
    return n <= 1 ? 1 : n * fact(n - 1)
}
const fib func(number) number = n => n < 2 ? n : fib(n - 1) + fib(n - 2)
console.log(fact(5), fib(10))`),
    ).toEqual(['120 55']);
  });
});

describe('event handlers in the initializer of their element', () => {
  it.each([
    ['code', 'const button = <button onClick={button.remove()}>x</button>'],
    ['a function', 'const button = <button onClick={() => button.remove()}>x</button>'],
    [
      'code with the event',
      'const input = <input onInput={console.log(input.value, event.data)} />',
    ],
    [
      'a handler property of a component',
      `comp Close(onPress func()) {
    return <button onClick={onPress()}>×</button>
}
const box = <div><Close onPress={box.remove()} /></div>`,
    ],
  ])('accepts %s', (_, source) => {
    expect(errors(source)).toEqual([]);
  });

  it('checks the handler with the type of the element', () => {
    expect(errors('const button = <button onClick={button.nope()}>x</button>')).toEqual([
      'HTMLButtonElement has no member "nope"',
    ]);
  });

  it('rejects the element in an attribute: it is read right away', () => {
    expect(errors('const button = <button title={button.title}>x</button>')).toEqual([
      '"button" is used in its own initializer, before it has a value',
    ]);
  });

  it('runs a handler that removes its own element', () => {
    expect(
      runWithDom(`const list = <ul><li>a</li></ul>
const close = <button onClick={close.remove()}>×</button>
list.append(close)
close.click()
console.log(list)`),
    ).toEqual(['<ul><li>a</li></ul>']);
  });
});
