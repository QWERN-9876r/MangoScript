import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { build } from '../src/build.ts';

// `.d.ts` files that `mango build` writes next to the `.js`, so that TypeScript code can use
// MangoScript modules with types. They are checked by the TypeScript compiler itself.

const GEOM = `export interface Point {
    x, y number
}
`;

const TODOS = `import { Point } from "./geom.mango"

export type Filter "all" | "active" | "done"

interface Internal {
    secret string
}

export interface Todo {
    title string
    done bool
    note ?string
    tags []string
    rename(title string) Todo
}

export interface Box[T] {
    value T
}

export const VERSION = "1.0"

export func divide(a, b number) (number, error) {
    if b == 0 {
        return 0, error("division by zero")
    }
    return a / b, null
}

export func first[T any](xs []T) ?T {
    return xs.length > 0 ? xs[0] : null
}

export func filterTodos(todos []Todo, filter Filter) []Todo {
    return todos.filter(todo => filter == "all" || (filter == "done") == todo.done)
}

export func makeInternal() Internal {
    return { secret: "x" }
}

export func onChange(handler func(string | number) bool) {
}

export func origin() Point {
    return { x: 0, y: 0 }
}

export class Stack[T] {
    private items []T
    protected size number
    static created = 0

    constructor() {
        this.size = 0
    }

    push(item T) {
        this.items.push(item)
        this.size += 1
    }

    pop() ?T {
        return this.items.pop() ?? null
    }
}

export class Animal {
    name string

    constructor(name string) {
        this.name = name
    }

    speak() string {
        return this.name
    }
}

export class Dog extends Animal {
    speak() string {
        return "woof"
    }
}
`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mango-dts-'));
  writeFileSync(join(dir, 'geom.mango'), GEOM);
  writeFileSync(join(dir, 'todos.mango'), TODOS);
  const { outputs, errors } = build([join(dir, 'todos.mango')]);
  expect(errors).toEqual([]);
  for (const output of outputs) {
    writeFileSync(output.output, output.code);
    if (output.declarations) writeFileSync(output.declarations.output, output.declarations.code);
  }
});

/** Errors of a TypeScript file that imports the built modules, the `.d.ts` files included. */
function typescriptErrors(source: string): string[] {
  const file = join(dir, `consumer-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, source);
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0]!);
}

describe('declaration files', () => {
  it('maps MangoScript types to TypeScript', () => {
    expect(readFileSync(join(dir, 'todos.d.ts'), 'utf8')).toBe(`import { Point } from "./geom.js";
export type Filter = "all" | "active" | "done";
interface Internal {
    secret: string;
}
export interface Todo {
    title: string;
    done: boolean;
    note?: string | null;
    tags: string[];
    rename(title: string): Todo;
}
export interface Box<T> {
    value: T;
}
export declare const VERSION: string;
export declare function divide(a: number, b: number): [number, Error | null];
export declare function first<T>(xs: T[]): T | null;
export declare function filterTodos(todos: Todo[], filter: Filter): Todo[];
export declare function makeInternal(): Internal;
export declare function onChange(handler: (arg1: string | number) => boolean): void;
export declare function origin(): Point;
export declare class Stack<T> {
    private items;
    protected size: number;
    static created: number;
    constructor();
    push(item: T): void;
    pop(): T | null;
}
export declare class Animal {
    name: string;
    constructor(name: string);
    speak(): string;
}
export declare class Dog extends Animal {
    speak(): string;
}
`);
  });

  it('are accepted by the TypeScript compiler', () => {
    expect(
      typescriptErrors(`import { divide, first, filterTodos, origin, Stack, Dog, VERSION } from "./todos.js";
import type { Todo, Filter, Box } from "./todos.js";

const [quotient, error]: [number, Error | null] = divide(1, 2);
const head: number | null = first([1, 2]);
const todos: Todo[] = filterTodos([{ title: "a", done: false, tags: [], rename: (title) => todos[0]! }], "done");
const filter: Filter = "active";
const box: Box<string> = { value: "a" };
const stack = new Stack<string>();
stack.push("a");
const top: string | null = stack.pop();
const sound: string = new Dog("Rex").speak();
const x: number = origin().x;
const version: string = VERSION;
console.log(quotient, error, head, filter, box, top, sound, x, version);
`),
    ).toEqual([]);
  });

  it('let TypeScript find type errors in code that uses the module', () => {
    expect(
      typescriptErrors(`import { filterTodos, Stack } from "./todos.js";
filterTodos([], "everything");
new Stack<number>().push("a");
`),
    ).toEqual([
      `Argument of type '"everything"' is not assignable to parameter of type 'Filter'.`,
      `Argument of type 'string' is not assignable to parameter of type 'number'.`,
    ]);
  });
});
