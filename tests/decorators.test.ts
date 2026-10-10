import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { parse } from '../src/parser/parser.ts';
import { first, inFunction, sx } from './parser-helpers.ts';

// Decorators: `dec name(...) { ... }`, applied as `@name(...)` before `comp`; the component reads
// their public state with `get(@name.member)` and calls their public functions as `@name.f()`.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);

  return check(program).diagnostics.map((d) => d.message);
}

const counter = `dec counter(start number = 0) {
    public state count = start
    public const step = 1
    public state items []number = []
    let clicks = 0

    public func add() {
        count += step
        clicks++
    }
}
`;

describe('syntax', () => {
  it('parses a declaration with public members', () => {
    const node = first(counter, 'DecoratorDeclaration');

    expect(node.name.name).toBe('counter');
    expect(node.params.map((param) => param.defaultValue !== null)).toEqual([true]);

    const members = node.body.body.map((statement) =>
      statement.kind === 'VariableDeclaration'
        ? `${statement.isPublic ? 'public ' : ''}${statement.keyword} ${statement.names[0]!.name}`
        : statement.kind === 'FuncDeclaration'
          ? `${statement.isPublic ? 'public ' : ''}func ${statement.name.name}`
          : statement.kind,
    );

    expect(members).toEqual([
      'public state count',
      'public const step',
      'public state items',
      'let clicks',
      'public func add',
    ]);
  });

  it('parses decorators before a component, with @html-tag first', () => {
    const node = first(
      '@html-tag("app-box")\n@visible("300px", true)\n@counter export comp Box() {\n    return <p />\n}',
      'ComponentDeclaration',
    );

    expect(node.exported).toBe(true);
    expect(node.htmlTag?.name?.value).toBe('app-box');
    expect(node.decorators.map((use) => [use.name.name, use.arguments.map(sx)])).toEqual([
      ['visible', ['"300px"', 'true']],
      ['counter', []],
    ]);
  });

  it('parses reading and calling members', () => {
    const [declaration, call] = inFunction(
      'const n = get(@counter.count).toFixed()\n@counter.add()',
    );

    expect(declaration?.kind === 'VariableDeclaration' && sx(declaration.values[0]!)).toBe(
      '(call (. (get @counter.count) toFixed))',
    );
    expect(call?.kind === 'ExpressionStatement' && sx(call.expression)).toBe('(call @counter.add)');
  });

  it('keeps dec, public and get ordinary names elsewhere', () => {
    expect(
      errors(
        'const dec = 1\nconst public = dec\nfunc get(x number) number {\n    return x\n}\nconst n = get(public)',
      ),
    ).toEqual([]);
  });

  it.each([
    [
      'func f() {\n    dec a() {\n    }\n}',
      'decorators can only be declared at the top level of a module',
    ],
    [
      'dec a() {\n    public let x = 1\n}',
      'a decorator has no "public let": a value that changes and is read outside is a state, one that does not change is a const',
    ],
    [
      'dec a() {\n    public mount() {\n    }\n}',
      'only state, const and func can be public, not "mount"',
    ],
    ['@a(...xs) comp B() {\n    return <p />\n}', 'arguments of a decorator cannot be spread'],
    [
      'comp B() {\n    return <p>{get(@a.b, 1)}</p>\n}',
      'expected ")": get takes one member of a decorator, e.g. get(@visible.shown), found ","',
    ],
    [
      '@a\nfunc b() {\n}',
      'decorators are written before a component, as in @a comp MainPage() { ... }',
    ],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('types', () => {
  const use = (body: string, decorators = '@counter(1)') =>
    errors(`${counter}${decorators}\ncomp Clicker(label string) {\n${body}\n    return <p />\n}`);

  it('gives members of applied decorators their types', () => {
    expect(
      use(`    const n number = get(@counter.count) + get(@counter.step)
    const total number = get(@counter.items).length
    const add func() = @counter.add
    @counter.add()`),
    ).toEqual([]);
    expect(use('    const s string = get(@counter.count)')).toEqual([
      'cannot use number as string',
    ]);
  });

  it('checks the arguments like those of a function', () => {
    expect(use('', '@counter')).toEqual([]);
    expect(use('', '@counter(label.length)')).toEqual([]);
    expect(use('', '@counter("one")')).toEqual([
      'cannot use string as number for "start" of @counter',
    ]);
    expect(use('', '@counter(1, 2)')).toEqual(['@counter takes 1 argument']);
    expect(errors(`dec a(x number) {\n}\n@a\ncomp B() {\n    return <p />\n}`)).toEqual([
      '@a needs the argument "x"',
    ]);
    expect(errors(`dec a(x number = 1, y number) {\n}`)).toEqual([
      '"y" needs a default value: the arguments are positional, so parameters with default values go last',
    ]);
  });

  it('reports wrong uses of decorators', () => {
    expect(use('', '@counter @counter')).toEqual(['@counter is applied twice: apply it once']);
    expect(use('', '@missing')).toEqual(['unknown decorator @missing']);
    expect(use('    const x = get(@other.count)')).toEqual(['unknown decorator @other']);
    expect(use('    const x = get(@counter.count)', '')).toEqual([
      '@counter is not applied to Clicker: write @counter before comp',
    ]);
    expect(errors(`${counter}func f() {\n    @counter.add()\n}`)).toEqual([
      '@counter.add can only be used in a component that @counter is applied to',
    ]);
    expect(errors(`${counter}dec counter() {\n}`)).toEqual([
      'the decorator @counter is already declared',
    ]);
  });

  it('reads state and constants with get and calls functions', () => {
    expect(use('    const x = @counter.count')).toEqual([
      'read "count" of @counter with get(@counter.count)',
    ]);
    expect(use('    get(@counter.add)()')).toEqual([
      '"add" of @counter is a function: call it, @counter.add()',
    ]);
    expect(use('    const x = get(@counter.clicks)')).toEqual([
      '"clicks" of @counter is not public: write "public" before its declaration',
    ]);
    expect(use('    const x = get(@counter.start)')).toEqual([
      '"start" of @counter is not public: write "public" before its declaration',
    ]);
    expect(use('    const x = get(@counter.size)')).toEqual(['@counter has no member "size"']);
    expect(use('    const x = counter.count')).toEqual([
      '"counter" is not defined; to read public state of @counter write get(@counter.count)',
    ]);
    expect(use('    counter.add()')).toEqual([
      '"counter" is not defined; to call a function of @counter write @counter.add()',
    ]);
  });

  it('keeps members read-only outside the decorator', () => {
    const readOnly =
      '"count" of @counter is read-only outside it; change it with one of its public functions, e.g. @counter.add()';

    expect(use('    get(@counter.count) = 2')).toEqual([readOnly]);
    expect(use('    get(@counter.count)++')).toEqual([readOnly]);
    expect(use('    get(@counter.items).push(1)')).toEqual([
      readOnly.replace('"count"', '"items"'),
    ]);
    expect(use('    get(@counter.items)[0] = 1')).toEqual([readOnly.replace('"count"', '"items"')]);
    expect(use('    const copy = get(@counter.items).slice()\n    copy.push(1)')).toEqual([]);
    expect(errors('dec a(x number) {\n    func f() {\n        x = 2\n    }\n}')).toEqual([
      'cannot assign to "x": parameters of a decorator are read-only',
    ]);
  });

  it('checks the body of a decorator once, by itself', () => {
    expect(errors('dec a() {\n    const n number = "one"\n}')).toEqual([
      'cannot use string as number',
    ]);
    expect(errors(`${counter}dec a() {\n    func f() {\n        @counter.add()\n    }\n}`)).toEqual(
      ['@a can use @counter only if it needs it: write "needs counter" after its parameters'],
    );
    expect(errors('dec a() {\n    defer console.log(1)\n}')).toEqual([
      'defer is not supported in decorators yet',
    ]);
    expect(errors('dec a() {\n    mount() {\n        return 1\n    }\n}')).toEqual([
      'mount() returns the function that cleans up, e.g. return () => clearInterval(timer), not number',
    ]);
  });

  it('does not let the component hide the names the decorator uses', () => {
    const logger = 'func log(text string) {\n}\ndec logged(text string) {\n    log(text)\n}\n';

    expect(
      errors(`${logger}@logged("a")\ncomp A() {\n    const log = 1\n    return <p />\n}`),
    ).toEqual([
      '@logged uses "log" of the module, but A declares its own "log": rename one of them',
    ]);
    expect(
      errors(
        `const title = "t"\n${logger}@logged(title)\ncomp A() {\n    const title = 2\n    return <p />\n}`,
      ),
    ).toEqual([
      'the arguments of @logged use "title" of the module, but A declares its own "title": rename one of them',
    ]);
    // Names of nested functions are out of the decorator's way.
    expect(
      errors(
        `${logger}@logged("a")\ncomp A() {\n    func f() {\n        const log = 1\n    }\n    return <p />\n}`,
      ),
    ).toEqual([]);
    // The decorator's own names are renamed, so they cannot clash with the component's.
    expect(use('    const count = 2\n    const add = 3')).toEqual([]);
  });
});
