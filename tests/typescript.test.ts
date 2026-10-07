import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { DeclarationImporter } from '../src/typescript/importer.ts';

// Types of imports from TypeScript declarations: packages with `.d.ts`, `.ts` files and
// `node:` modules from @types/node.

const SHAPES = `export interface Point { x: number; y: number; label?: string }
export declare function distance(a: Point, b: Point): number;
export declare function parsePoint(text: string): Point;
export declare function parsePoint(text: string, strict: boolean): Point | null;
export declare function format(value: number): string;
export declare function format(value: string, pattern: "short" | "long"): string;

export declare class Shape {
  constructor(name: string);
  readonly name: string;
  protected secret: number;
  area(): number;
  static create(name: string): Shape;
}
export declare class Circle extends Shape {
  constructor(radius: number);
  radius: number;
}
export declare class Box<T> {
  constructor(value: T);
  value: T;
  map<U>(f: (value: T) => U): Box<U>;
}
export declare class Emitter<Events = Record<string, unknown>> {
  on(name: string, listener: (...args: any[]) => void): this;
}

export interface Tree<T> { value: T; children: Tree<T>[] }
export type Named = { name: string } & { id: number };
export type Pair<A, B> = { first: A; second: B };
export declare enum Color { Red = "red", Green = "green" }
export declare function paint(color: Color): void;
export interface Scores { [name: string]: number }
export declare const scores: Scores;
export interface Listener { (event: string): void }
export declare function listen(listener: Listener): void;
export declare function first<T>(items: T[]): T | undefined;
export declare function pair(): [string, number];
export declare function optional(a: string, b?: number, ...rest: boolean[]): void;
export default function greet(name: string): string;
`;

const LEGACY = `declare namespace legacy {
  interface Options { verbose: boolean }
  const version: string;
}
declare function legacy(options: legacy.Options): string;
export = legacy;
`;

let project: string;
let importer: DeclarationImporter;

function write(path: string, text: string): void {
  mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(join(project, path), text);
}

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'mango-ts-'));
  write('node_modules/shapes/package.json', '{ "name": "shapes", "types": "index.d.ts" }');
  write('node_modules/shapes/index.d.ts', SHAPES);
  write('node_modules/legacy/package.json', '{ "name": "legacy", "types": "index.d.ts" }');
  write('node_modules/legacy/index.d.ts', LEGACY);
  write('node_modules/plain/package.json', '{ "name": "plain", "main": "index.js" }');
  write('node_modules/plain/index.js', 'module.exports = {}');
  write('util.ts', 'export function double(x: number): number { return x * 2 }\n');
  importer = new DeclarationImporter();
});

/** Errors of a module in the temporary project. */
function errors(source: string, file = join(project, 'main.mango')): string[] {
  const { program, diagnostics } = parse(source);
  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);
  const options = { importDeclarations: (specifier: string) => importer.import(file, specifier) };
  return check(program, options).diagnostics.map((d) => d.message);
}

const shapes = (names: string) => `import { ${names} } from "shapes"\n`;

describe('functions and interfaces', () => {
  it('checks calls against declared signatures', () => {
    expect(
      errors(`${shapes('distance, Point')}const d number = distance({ x: 1, y: 2 }, { x: 0, y: 0 })
const p Point = { x: 1, y: 2 }
distance(p, 1)`),
    ).toEqual(['cannot use number as Point in argument 2']);
  });

  it('makes optional properties nullable', () => {
    expect(
      errors(`${shapes('parsePoint')}const p = parsePoint("1,2")
const x number = p.x
const label string = p.label`),
    ).toEqual(['cannot use ?string as string: it may be null, check it first']);
  });

  it('picks the overload that fits the arguments', () => {
    expect(
      errors(`${shapes('parsePoint, format, Point')}const a Point = parsePoint("1,2")
const b Point = parsePoint("1,2", true)
const c string = format(1)
const d string = format("x", "short")`),
    ).toEqual(['cannot use ?Point as Point: it may be null, check it first']);
    expect(errors(`${shapes('format')}format(true)`)).toEqual([
      'no overload fits these arguments: func(number) string; func(string, "short" | "long") string',
    ]);
  });

  it('infers type arguments of generic functions', () => {
    expect(
      errors(`${shapes('first')}const n ?number = first([1, 2])
const s string = first(["a"])`),
    ).toEqual(['cannot use ?string as string: it may be null, check it first']);
  });

  it('supports optional and rest parameters', () => {
    expect(
      errors(`${shapes('optional')}optional("a")
optional("a", 1, true, false)
optional()`),
    ).toEqual(['not enough arguments: expected 1, got 0']);
  });

  it('gives callbacks the parameter types of callable interfaces', () => {
    expect(
      errors(`${shapes('listen')}listen(event => console.log(event.length))
listen(event => console.log(event.toFixed(1)))`),
    ).toEqual(['string has no member "toFixed"']);
  });

  it('converts tuples, intersections, enums and index signatures', () => {
    expect(
      errors(`${shapes('pair, Named, Color, paint, scores')}const values [](string | number) = pair()
const named Named = { name: "a", id: 1 }
const partial Named = { name: "a" }
paint(Color.Red)
paint("blue")
const score number = scores.anna`),
    ).toEqual([
      'cannot use { name string } as { name string; id number }: missing "id"',
      'cannot use "blue" as "red" | "green" in argument 1',
    ]);
  });

  it('supports generic interfaces and aliases that refer to themselves', () => {
    expect(
      errors(`${shapes('Tree, Pair')}func sum(tree Tree[number]) number {
    let total = tree.value
    for child in tree.children {
        total += sum(child)
    }
    return total
}
sum({ value: 1, children: [] })
const p Pair[number, string] = { first: 1, second: "a" }
const s string = p.first`),
    ).toEqual(['cannot use number as string']);
  });
});

describe('classes', () => {
  it('checks constructors, members, statics and visibility', () => {
    expect(
      errors(`${shapes('Shape, Circle')}const c = new Circle(2)
const area number = c.area()
const s Shape = c
const name string = Shape.create("a").name
new Shape(1)
const secret = c.secret`),
    ).toEqual(['cannot use number as string in argument 1', '"secret" is protected in Circle']);
  });

  it('narrows with instanceof', () => {
    expect(
      errors(`${shapes('Shape, Circle')}func radius(shape Shape) number {
    if shape instanceof Circle {
        return shape.radius
    }
    return 0
}`),
    ).toEqual([]);
  });

  it('infers type arguments of generic classes and methods', () => {
    expect(
      errors(`${shapes('Box')}const box = new Box(1)
const n number = box.value
const strings Box[string] = box.map(value => value.toString())
const wrong string = box.value`),
    ).toEqual(['cannot use number as string']);
  });

  it('lets MangoScript classes extend declared ones', () => {
    expect(
      errors(`${shapes('Shape, Emitter')}class Square extends Shape {
    constructor() {
        super("square")
    }
    area() number {
        return 1
    }
}
const name string = new Square().name
class Bus extends Emitter {
}
new Bus().on("stop", () => console.log("stop"))`),
    ).toEqual([]);
  });
});

describe('modules', () => {
  it('imports the default export', () => {
    expect(errors('import greet from "shapes"\nconst text string = greet("Anna")')).toEqual([]);
  });

  it('imports CommonJS modules with export =', () => {
    expect(
      errors(`import legacy from "legacy"
import { version } from "legacy"
const out string = legacy({ verbose: true })
const v number = version`),
    ).toEqual(['cannot use string as number']);
  });

  it('imports namespaces', () => {
    expect(
      errors(
        'import * as s from "shapes"\nconst d string = s.distance({ x: 1, y: 1 }, { x: 0, y: 0 })',
      ),
    ).toEqual(['cannot use number as string']);
  });

  it('imports .ts files', () => {
    expect(errors('import { double } from "./util.ts"\ndouble("2")')).toEqual([
      'cannot use string as number in argument 1',
    ]);
  });

  it('reports names a module does not export', () => {
    expect(errors('import { missing } from "shapes"')).toEqual([
      '"missing" is not exported by "shapes"',
    ]);
  });

  it('leaves modules without declarations untyped', () => {
    expect(
      errors(`import plain from "plain"
import { anything } from "./script.js"
plain.whatever(1, 2)
anything()`),
    ).toEqual([]);
  });

  it('reads node: modules from @types/node', () => {
    const file = join(import.meta.dirname, 'main.mango');
    expect(
      errors(
        `import { readFileSync } from "node:fs"
import { join } from "node:path"
const text string = readFileSync("a.txt", "utf8")
const bytes string = readFileSync("a.txt")
const path number = join("a", "b")`,
        file,
      ),
    ).toEqual(['cannot use Buffer[ArrayBuffer] as string', 'cannot use string as number']);
  });

  it('is used by compile() for files with a name', () => {
    const file = join(project, 'app.mango');
    const { diagnostics } = compile('import { distance } from "shapes"\ndistance(1, 2)', {
      filename: file,
    });
    expect(diagnostics.map((d) => d.message)).toEqual([
      'cannot use number as Point in argument 1',
      'cannot use number as Point in argument 2',
    ]);
  });
});
