import { describe, expect, it } from 'vitest';
import type * as ast from '../src/ast.ts';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';

// Generics in the style of Go: `func first[T any](xs []T) T`, `interface Box[T]`,
// `class Stack[T]`, and type arguments in types: `Box[number]`.

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

const stack = `class Stack[T] {
    private items []T

    push(item T) {
        this.items.push(item)
    }

    pop() ?T {
        return this.items.pop() ?? null
    }

    size() number {
        return this.items.length
    }
}
`;

describe('syntax', () => {
  it('parses type parameters and type arguments', () => {
    const { program, diagnostics } = parse(`func first[T any](xs []T) T {
    return xs[0]
}
func pick[K, V any, S Shape](a K) V {
    return a
}
interface Box[T] {
    value T
}
type Pair[A, B any] {
    first A
    second B
}
let b Box[[]number] = { value: [1] }
let m Pair[string, ?number] = { first: "a", second: null }`);

    expect(diagnostics).toEqual([]);

    const first = program.body[0] as ast.FuncDeclaration;

    expect(first.typeParams.map((param) => param.name.name)).toEqual(['T']);

    const pick = program.body[1] as ast.FuncDeclaration;

    expect(pick.typeParams.map((param) => param.name.name)).toEqual(['K', 'V', 'S']);
    // `K, V any`: every name of the group has the constraint.
    expect(pick.typeParams.map((param) => param.constraint?.kind)).toEqual([
      'TypeReference',
      'TypeReference',
      'TypeReference',
    ]);

    const box = (program.body[4] as ast.VariableDeclaration).type as ast.TypeReference;

    expect(box.typeArgs.map((arg) => arg.kind)).toEqual(['ArrayType']);

    const pair = (program.body[5] as ast.VariableDeclaration).type as ast.TypeReference;

    expect(pair.typeArgs.map((arg) => arg.kind)).toEqual(['TypeReference', 'NullableType']);
  });

  it('still parses indexing and array types', () => {
    expect(errors('let xs [][]number = [[1]]\nlet x = xs[0][0]\nlet y number = x')).toEqual([]);
  });
});

describe('generic functions', () => {
  it('infers type arguments from the arguments', () => {
    expect(
      errors(`func first[T any](xs []T) ?T {
    return xs.length > 0 ? xs[0] : null
}
let n ?number = first([1, 2])
let s ?string = first(["a"])`),
    ).toEqual([]);
    expect(
      errors(`func first[T any](xs []T) T {
    return xs[0]
}
let s string = first([1, 2])`),
    ).toEqual(['cannot use number as string']);
  });

  it('checks that arguments agree on a type parameter', () => {
    expect(
      errors(`func same[T any](a T, b T) bool {
    return a == b
}
same(1, 2)
same(1, "a")`),
    ).toEqual(['cannot use string as number in argument 2']);
  });

  it('infers type arguments from the expected type', () => {
    expect(
      errors(`func empty[T any]() []T {
    return []
}
let xs []number = empty()
xs.push(1)`),
    ).toEqual([]);
  });

  it('infers type arguments of functions passed as arguments', () => {
    expect(
      errors(`func mapAll[T, U any](xs []T, f func(T) U) []U {
    let out []U
    for x in xs {
        out.push(f(x))
    }
    return out
}
let lengths []number = mapAll(["a", "bc"], s => s.length)
let wrong []string = mapAll([1], n => n * 2)`),
    ).toEqual(['cannot use []number as []string']);
  });

  it('treats a type parameter as its own type inside the function', () => {
    expect(
      errors(`func wrong[T any](x T) T {
    return 1
}`),
    ).toEqual(['cannot use number as T in return']);
    expect(
      errors(`func size[T any](x T) number {
    return x.length
}`),
    ).toEqual(['T has no member "length": give the type parameter a constraint, e.g. [T Shape]']);
  });

  it('gives a type parameter the members of its constraint', () => {
    const source = `interface Named {
    name string
}
func names[T Named](xs []T) []string {
    return xs.map(x => x.name)
}
`;

    expect(errors(`${source}names([{ name: "a", age: 1 }])`)).toEqual([]);
    expect(errors(`${source}names([1])`)).toEqual([
      'number does not satisfy the constraint Named of T',
    ]);
  });

  it('reports type parameters that nothing gives', () => {
    expect(
      errors(`func empty[T any]() []T {
    return []
}
let xs = empty()`),
    ).toEqual(['cannot infer T: declare the type of the result']);
    expect(
      errors(`func zero[T any]() T {
    let x T
    return x
}`),
    ).toEqual(['T has no zero value: give "x" a value or make it nullable with ?T']);
  });

  it('compiles to plain JS functions', () => {
    expect(
      run(`func last[T any](xs []T) ?T {
    return xs.length > 0 ? xs[xs.length - 1] : null
}
console.log(last([1, 2, 3]), last(["a"]), last([]))`),
    ).toEqual(['3 a null']);
  });
});

describe('generic interfaces and aliases', () => {
  it('substitutes type arguments into members', () => {
    expect(
      errors(`interface Box[T] {
    value T
    get() T
}
let b Box[number] = { value: 1, get: () => 2 }
let n number = b.value + b.get()
let s string = b.value`),
    ).toEqual(['cannot use number as string']);
  });

  it('supports generic aliases of any type', () => {
    expect(
      errors(`type List[T] []T
type Maybe[T] ?T
let xs List[string] = ["a"]
let x Maybe[number] = null
let y string = xs[0]
let z List[number] = ["a"]`),
    ).toEqual(['cannot use string as number']);
  });

  it('supports types that refer to themselves', () => {
    expect(
      errors(`interface Tree[T] {
    value T
    children []Tree[T]
}
func sum(tree Tree[number]) number {
    let total = tree.value
    for child in tree.children {
        total += sum(child)
    }
    return total
}
let tree Tree[number] = { value: 1, children: [{ value: 2, children: [] }] }
sum(tree)
let bad Tree[number] = { value: 1, children: [{ value: "a", children: [] }] }`),
    ).toHaveLength(1);
  });

  it('compares instances by their type arguments', () => {
    expect(
      errors(`interface Box[T] {
    value T
}
let a Box[number] = { value: 1 }
let b Box[number] = a
let c Box[string] = a`),
    ).toEqual(['cannot use Box[number] as Box[string]: "value" is number, not string']);
  });

  it('infers type arguments of generic interfaces in calls', () => {
    expect(
      errors(`interface Box[T] {
    value T
}
func unbox[T any](box Box[T]) T {
    return box.value
}
let b Box[string] = { value: "a" }
let s string = unbox(b)
let n number = unbox(b)`),
    ).toEqual(['cannot use string as number']);
  });

  it('checks the number of type arguments and constraints', () => {
    const box = 'interface Box[T] {\n    value T\n}\n';

    expect(errors(`${box}let b Box = { value: 1 }`)).toEqual([
      '"Box" needs type arguments: Box[T]',
    ]);
    expect(errors(`${box}let b Box[number, string] = { value: 1 }`)).toEqual([
      '"Box" takes 1 type argument, got 2',
    ]);
    expect(errors('let n number[string] = 1')).toEqual(['"number" is not generic']);
    expect(
      errors(`interface Named {
    name string
}
interface Labeled[T Named] {
    item T
}
let a Labeled[Named] = { item: { name: "a" } }
let b Labeled[number] = { item: 1 }`),
    ).toEqual(['number does not satisfy the constraint Named of T']);
  });
});

describe('generic classes', () => {
  it('infers type arguments from the constructor or the expected type', () => {
    expect(
      errors(`${stack}let s Stack[number] = new Stack()
s.push(1)
let top ?number = s.pop()
s.push("a")`),
    ).toEqual(['cannot use string as number in argument 1']);
    expect(
      errors(`class Box[T] {
    value T
    constructor(value T) {
        this.value = value
    }
}
let b = new Box("a")
let s string = b.value
let n number = b.value`),
    ).toEqual(['cannot use string as number']);
  });

  it('needs the type arguments of a new instance from somewhere', () => {
    expect(errors(`${stack}let s = new Stack()`)).toEqual([
      'cannot infer T: declare the type of the result',
    ]);
  });

  it('does not extend generic classes', () => {
    expect(errors(`${stack}class Numbers extends Stack {\n}`)).toEqual([
      'cannot extend the generic class "Stack": generic base classes are not supported',
    ]);
  });

  it('keeps instances with different arguments apart', () => {
    expect(
      errors(`${stack}let a Stack[number] = new Stack()
let b Stack[string] = a`),
    ).toEqual(['cannot use Stack[number] as Stack[string]']);
  });

  it('checks implements with type arguments', () => {
    expect(
      errors(`interface Source[T] {
    next() ?T
}
class Counter implements Source[number] {
    private n number
    next() ?number {
        this.n += 1
        return this.n
    }
}
class Wrong implements Source[string] {
    next() ?number {
        return null
    }
}`),
    ).toHaveLength(1);
  });

  it('compiles to plain JS classes', () => {
    expect(
      run(`${stack}let s Stack[string] = new Stack()
s.push("a")
s.push("b")
console.log(s.pop(), s.size())`),
    ).toEqual(['b 1']);
  });
});
