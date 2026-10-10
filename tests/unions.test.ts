import { describe, expect, it } from 'vitest';
import type * as ast from '../src/ast.ts';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';

// Union and literal types: `string | number`, `type Filter "all" | "active"`, and narrowing them
// with typeof, instanceof, comparisons and switch.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);

  return check(program).diagnostics.map((d) => d.message);
}

/** Runs a program and returns what it printed. */
function run(source: string): string[] {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  const output: string[] = [];
  const log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const program = new Function('console', code) as (console: { log: typeof log }) => void;

  program({ log });

  return output;
}

const point = `class Point {
    x number
    constructor(x number) {
        this.x = x
    }
}
`;

describe('syntax', () => {
  it('parses unions, literal types and parentheses', () => {
    const { program, diagnostics } = parse(
      'let a string | number = 1\ntype Filter "all" | "done"\nlet b [](string | 2 | true)\nlet c ?(Filter | number)',
    );

    expect(diagnostics).toEqual([]);

    const first = program.body[0] as ast.VariableDeclaration;

    expect(first.type?.kind).toBe('UnionType');

    const alias = program.body[1] as ast.TypeAliasDeclaration;
    const union = alias.type as ast.UnionType;

    expect(union.types.map((type) => type.kind)).toEqual(['LiteralType', 'LiteralType']);

    const array = (program.body[2] as ast.VariableDeclaration).type as ast.ArrayType;

    expect(array.element.kind).toBe('UnionType');

    const nullable = (program.body[3] as ast.VariableDeclaration).type as ast.NullableType;

    expect(nullable.type.kind).toBe('UnionType');
  });
});

describe('type checking', () => {
  it('accepts values of any member and literals of the type', () => {
    expect(
      errors(`type Filter "all" | "active" | "done"
let id string | number = 1
id = "a"
let filter Filter = "all"
filter = "done"
func set(f Filter) {}
set("active")
const either = filter == "done" ? 1 : "нет"
const mixed = [1, "a", true]
const n number | string = mixed.length > 2 ? 0 : ""`),
    ).toEqual([]);
  });

  it.each([
    ['type Filter "all" | "done"\nlet f Filter = "al"', 'cannot use "al" as Filter'],
    ['let x string | number = true', 'cannot use bool as string | number'],
    [
      'func f(x string | number) number {\n    return x.length\n}',
      'string | number has no member "length" in every type: narrow it with typeof or instanceof',
    ],
    [
      'type Filter "all" | "done"\nfunc f(x Filter) bool {\n    return x == "dne"\n}',
      'cannot compare Filter and "dne"',
    ],
    [
      'type Filter "all" | "done"\nlet f Filter',
      'Filter has no zero value: give "f" a value or make it nullable with ?Filter',
    ],
    ['let x 1 | 2 = 3', 'cannot use 3 as 1 | 2'],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });

  it('uses members that every type of a union has', () => {
    expect(errors('func f(x string | number) string {\n    return x.toString()\n}')).toEqual([]);
    expect(errors('func f(x string | []number) number {\n    return x.length\n}')).toEqual([]);
  });

  it('narrows with typeof, in both branches and in && and ?:', () => {
    expect(
      errors(`func f(x string | number | bool) string {
    if typeof x == "string" {
        return x.toUpperCase()
    }
    if typeof x != "number" {
        return x ? "да" : "нет"
    }
    const fixed string = x.toFixed(1)
    const short = typeof x == "number" && x > 1
    return typeof x == "number" ? x.toFixed(2) : fixed
}
func g(value any) string {
    if typeof value == "string" {
        return value.toUpperCase()
    }
    return ""
}`),
    ).toEqual([]);
  });

  it('narrows the right side of && by the left one', () => {
    expect(
      errors(`func f(x string | number | bool) bool {
    return typeof x != "number" && typeof x != "string" && x
}`),
    ).toEqual([]);
  });

  it('narrows with instanceof', () => {
    expect(
      errors(`${point}func f(p Point | string) number {
    if p instanceof Point {
        return p.x
    }
    return p.length
}`),
    ).toEqual([]);
  });

  it('narrows literal types with comparisons and switch', () => {
    expect(
      errors(`type Filter "all" | "active" | "done"
func label(filter Filter) string {
    if filter == "all" {
        const all "all" = filter
        return all
    }
    switch filter {
    case "active":
        const active "active" = filter
        return active
    default:
        const done "done" = filter
        return done
    }
}`),
    ).toEqual([]);
  });

  it('keeps narrowing apart from the types it does not apply to', () => {
    expect(
      errors(`func f(x string | number) string {
    if typeof x == "string" {
        return x
    }
    return x
}`),
    ).toEqual(['cannot use number as string in return']);
  });
});

describe('runtime behavior', () => {
  it('compiles narrowing to the same typeof and instanceof', () => {
    expect(
      run(`${point}type Shape Point | string | number
func show(value Shape) string {
    if typeof value == "string" {
        return value.toUpperCase()
    }
    if value instanceof Point {
        return \`точка \${value.x}\`
    }
    return value.toFixed(1)
}
for value in [new Point(2), "манго", 3] {
    console.log(show(value))
}`),
    ).toEqual(['точка 2', 'МАНГО', '3.0']);
  });
});
