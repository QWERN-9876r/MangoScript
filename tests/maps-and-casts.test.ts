import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { first, member, sx, ty } from './parser-helpers.ts';

// Objects used as maps, `{ [string]: T }`, with `delete`; function types written as arrows,
// `(x number) => string`; and `value as Type`.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);

  return check(program).diagnostics.map((d) => d.message);
}

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
}

describe('maps: { [string]: T }', () => {
  it('parses an index signature among the members', () => {
    const alias = first('type Scores { [string]: number; total number }', 'TypeAliasDeclaration');

    expect(alias.type.kind === 'ObjectType' && alias.type.members.map(member)).toEqual([
      '[string]: number',
      'total number',
    ]);
    expect(errors('type M { [bool]: number }')).toEqual([
      'the key of [key]: T is string or number, e.g. [string]: number',
    ]);
  });

  it('checks the values of object literals and reads values by any key', () => {
    expect(
      errors(
        'const scores { [string]: number } = { ann: 3, "bob-2": 4 }\nconst n number = scores["eve"] + scores.ann',
      ),
    ).toEqual([]);
    expect(errors('const scores { [string]: number } = { ann: "3" }')).toEqual([
      'cannot use string as number for field "ann"',
    ]);
    expect(errors('const o = { a: 1, b: 2 }\nconst m { [string]: number } = o')).toEqual([]);
    expect(errors('const o = { a: 1, b: "x" }\nconst m { [string]: number } = o')).toEqual([
      'cannot use { a number; b string } as { [string]: number }',
    ]);
  });

  it('writes the index signature into the .d.ts', () => {
    const { declarations } = compile('export const scores { [string]: number } = {}', {
      declarations: true,
    });

    expect(declarations).toContain('scores: { [key: string]: number; }');
  });
});

describe('delete', () => {
  it.each([
    ['const m { [string]: number } = { a: 1 }\ndelete m["a"]\ndelete m.b'],
    ['interface U { name string; nick ?string }\nconst u U = { name: "a" }\ndelete u.nick'],
    ['const a any = {}\ndelete a.x'],
  ])('deletes keys of maps, optional fields and anything untyped: %j', (source) => {
    expect(errors(source)).toEqual([]);
  });

  it.each([
    [
      'interface U { name string }\nconst u U = { name: "a" }\ndelete u.name',
      'cannot delete "name" of U: only keys of { [string]: T } and fields of type ?T can be deleted',
    ],
    ['const xs = [1]\ndelete xs[0]', 'delete leaves a hole in an array: remove items with splice'],
    ['let d = 1\ndelete d', 'delete removes a field: delete obj.key or delete obj[key]'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });

  it('keeps delete an ordinary name elsewhere, and compiles to delete', () => {
    expect(errors('const remove = (delete number) => delete + 1')).toEqual([]);
    expect(js('const m { [string]: number } = { a: 1 }\ndelete m["a"]')).toContain(
      'delete m["a"];',
    );
  });

  it('updates the markup that reads a map when a key is deleted', () => {
    const code = js(`comp A() {
    state counts { [string]: number } = { a: 1 }
    return <p onClick={delete counts.a}>{Object.keys(counts).length}</p>
}
document.body.append(<A />)`);

    expect(code).toMatch(
      /delete counts\.a;\n\s+\$\$text\d+\.data = Object\.keys\(counts\)\.length;/,
    );
  });
});

describe('function types as arrows', () => {
  it('parses (x T) => R as func(T) R, with or without names', () => {
    const named = first('let f (paths []string, n number) => string', 'VariableDeclaration');
    const plain = first('let f ([]string, number) => string', 'VariableDeclaration');

    expect(ty(named.type!)).toBe(ty(plain.type!));
    expect(ty(named.type!)).toBe('func([]string, number) string');
    expect(ty(first('let f () => void', 'VariableDeclaration').type!)).toBe('func()');
  });

  it('keeps parentheses for grouping', () => {
    expect(ty(first('let x [](string | number)', 'VariableDeclaration').type!)).toBe(
      '[](string | number)',
    );
    expect(errors('let x (number, string)')).toEqual([
      'types in parentheses are the parameters of a function type: (a A, b B) => R',
    ]);
  });

  it('checks values against the type', () => {
    expect(
      errors('const twice (n number) => number = n => n * 2\nconst x number = twice(2)'),
    ).toEqual([]);
    expect(errors('const f (x number) => string = x => x')).toEqual([
      'cannot use number as string in return',
    ]);
  });
});

describe('as', () => {
  it('parses as a comparison binds', () => {
    const value = first('const ok = a + b as number > c', 'VariableDeclaration').values[0]!;

    expect(sx(value)).toBe('(> (as (+ a b) number) c)');
  });

  it('allows related types and rejects others', () => {
    expect(
      errors(
        'const x any = 1\nconst n number = x as number\nconst el = document.body as HTMLElement\nconst f = "a" as "a" | "b"',
      ),
    ).toEqual([]);
    expect(errors('const n = 1\nconst s = n as string')).toEqual([
      'cannot use number as string, even with "as": the types are not related',
    ]);
  });

  it('leaves nothing in JS', () => {
    expect(js('const x any = 1\nconst n = (x as number) + 1\nconsole.log(n)')).toContain(
      'const n = x + 1;',
    );
  });
});
