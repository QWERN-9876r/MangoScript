import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';
import { first } from './parser-helpers.ts';

// `dec cartBadge() needs cart`: a decorator sees the public members of another one only if it names
// it with `needs`, and that one is applied above it.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);

  return check(program).diagnostics.map((d) => d.message);
}

const cart = `dec cart() {
    public state count = 0
    public state items []string = []

    public func add() {
        count++
    }
}
`;

/** Reads and calls the members of `cart` in its body, its functions and its wrapper. */
const badge = (needs = ' needs cart', more = '') => `dec cartBadge()${needs} {
    const start number = get(@cart.count)

    func addTwice() {
        @cart.add()
        @cart.add()
    }
${more}
    return (content Element) => <div>{content}<span onClick={addTwice()}>{get(@cart.count)}</span></div>
}
`;

const card = (decorators: string) => `${decorators}
comp Card() {
    return <p onClick={@cart.add()}>card</p>
}
`;

describe('syntax', () => {
  it('parses the decorators after needs', () => {
    const node = first('dec checkout() needs cart, auth {\n}', 'DecoratorDeclaration');

    expect(node.needs.map((need) => need.name)).toEqual(['cart', 'auth']);
    expect(first('dec a() {\n}', 'DecoratorDeclaration').needs).toEqual([]);
  });

  it('keeps needs an ordinary name elsewhere', () => {
    expect(errors('const needs = 1\ndec a(needs number) {\n    const x = needs\n}')).toEqual([]);
    expect(errors('dec a() needs {\n}')).toEqual([
      '"needs" is followed by the decorators this one uses, e.g. needs cart',
    ]);
  });
});

describe('types', () => {
  it('gives a decorator the members of the ones it needs, wherever they are declared', () => {
    expect(errors(badge() + cart + card('@cart\n@cartBadge'))).toEqual([]);
    expect(errors(cart + badge(' needs cart', '    const s string = get(@cart.count)\n'))).toEqual([
      'cannot use number as string',
    ]);
  });

  it('applies the needed decorators above', () => {
    const above = '@cartBadge needs @cart above it: @cart @cartBadge comp ...';

    expect(errors(cart + badge() + card('@cartBadge\n@cart'))).toEqual([above]);
    expect(errors(cart + badge() + card('@cartBadge'))).toEqual([
      above,
      '@cart is not applied to Card: write @cart before comp',
    ]);
  });

  it('reports wrong needs', () => {
    expect(errors(cart + badge(''))).toEqual(
      Array(4).fill(
        '@cartBadge can use @cart only if it needs it: write "needs cart" after its parameters',
      ),
    );
    expect(errors(`${cart}dec a() needs cart, auth {\n}`)).toEqual(['unknown decorator @auth']);
    expect(errors('dec a() needs a {\n}')).toEqual(['@a cannot need itself']);
    expect(errors(`${cart}dec a() needs cart, cart {\n}`)).toEqual([
      '@cart is needed twice: name it once',
    ]);
    expect(errors('dec a() needs b {\n}\ndec b() needs c {\n}\ndec c() needs a {\n}')).toEqual([
      'decorators cannot need each other: @a needs @b, @b needs @c, @c needs @a; remove one of the needs',
    ]);
    expect(errors('dec a() {\n    public state x = 1\n    const y = get(@a.x)\n}')).toEqual([
      'inside @a its members are used by their names: x',
    ]);
  });

  it('keeps the members of the needed decorator read-only', () => {
    expect(
      errors(cart + badge(' needs cart', '    func f() {\n        get(@cart.count) = 1\n    }\n')),
    ).toEqual([
      '"count" of @cart is read-only outside it; change it with one of its public functions, e.g. @cart.add()',
    ]);
  });
});

describe('running', () => {
  it('shares the state of the needed decorator with the component', () => {
    const { body } = mountWithDom(`${cart}${badge()}${card('@cart\n@cartBadge')}
document.body.append(<Card />)
`);

    body.find('p').click();
    expect(String(body)).toBe('<body><div><p>card</p><span>1</span></div></body>');
    body.find('span').click();
    expect(String(body)).toBe('<body><div><p>card</p><span>3</span></div></body>');
  });
});
