# MangoScript — draft specification v0

**English** · [Русский](spec.ru.md)

> Status: a draft, anything may change. Unresolved questions are collected under "Open questions".

MangoScript is a language with the semantics of JavaScript, Go-style syntax and static types. It
compiles to readable JavaScript (ES modules), and the types are erased at compile time.

## Principles

1. **JS semantics.** The same values, objects, classes, closures, modules and standard library
   (`console`, `Math`, `JSON`, methods of arrays and strings).
2. **Go syntax where it is more convenient:** `func`, the type after the name, multiple results,
   `defer`, zero values, conditions without parentheses, a single `for` loop, `switch` without
   `break`, no semicolons.
3. **Static types with null safety.** The compiler finds type errors; `null` can only be assigned
   to a type that explicitly allows it. JS code has no types.
4. **Compatibility with JS.** MangoScript can import any JS module, and a compiled module can be
   used from JS.

## 1. Lexical structure

### Comments

`// to the end of the line` and `/* block */`.

### Semicolons

They are written only to separate several statements on one line. Otherwise the lexer inserts them
by Go's rule: at the end of a line if its last token is

- an identifier or a literal (a number, a string, `true`, `false`, `null`);
- `this`, `return`, `break` or `continue`;
- `++`, `--`, `)`, `]`, `}`.

Hence, as in Go:

- the opening `{` is on the same line as `if`, `for`, `func`, `class`;
- when a long expression is split, the binary operator stays at the end of the line;
- no semicolon is needed before `}`: `if ok { return x }`.

**Unlike Go**, no semicolon is inserted if the next line starts

- with `.` or `?.`, so the familiar chains of calls work;
- with a closing `)`, `]` or `}`, so a comma after the last item of a multi-line list is optional.

```go
const names = users
    .filter(u => u.active)
    .map(u => u.name)

const point = {
    x: 1,
    y: 2
}
```

### Literals

- Numbers as in JS: `42`, `3.14`, `1e3`, `0xff`, `1_000_000`.
- Strings: `"..."`, `'...'` and template strings `` `Hello, ${name}` ``.
- `true`, `false`, `null`.
- Arrays `[1, 2, ...rest]` and objects `{ name: "Ann", age, "content-type": t, ...defaults }`
  (the shorthand `age` and spread are as in JS).

### Keywords

```
func  comp  return  let  const  type  interface  class  extends  new  this  super
if  else  for  in  break  continue  switch  case  default  defer
try  catch  finally  throw  import  export
null  true  false  typeof  instanceof
```

Inside a class declaration `static`, `private`, `protected`, `public` and `implements` are keywords
too, in `import` and `export` so is `from`, and at the start of a statement in a component's body,
`state` and `mount`. Elsewhere they are ordinary names. Reserved for the future: `map`, `async`,
`await`. The only decorator is `@html-tag` before `comp` (see "Web components").

After `.` and in object keys, keywords can be used as ordinary names: `xs.map(f)`, `event.type`,
`{ default: 1 }`.

Predeclared identifiers (not keywords, they can be redeclared): the types `number`, `string`,
`bool`, `any`, `error` and the function `error()`.

Names that start with `$$` are reserved for generated code (`$$defer`, `$$0`). Names that are valid
in MangoScript but not in JS (`delete`, `static`, `function`…) get a `$` suffix in the output:
`delete` → `delete$`.

## 2. Variables

```go
let count = 0              // the type is inferred: number
let name string = "Ann"
let total number           // the zero value: 0
const PI = 3.14
let a, b = 1, 2
```

```js
let count = 0;
let name = "Ann";
let total = 0;
const PI = 3.14;
let a = 1, b = 2;
```

A `const` cannot be reassigned; the compiler checks that.

Multiple assignment, as in Go:

```go
a, b = b, a                // → [a, b] = [b, a];
```

### Zero values

A variable or a class field without an initial value gets the zero value of its type, as in Go:

| Type                        | Zero value                    |
| --------------------------- | ----------------------------- |
| `number`                    | `0`                           |
| `string`                    | `""`                          |
| `bool`                      | `false`                       |
| `[]T`                       | `[]` (a new array each time)  |
| `?T`, `error`, `any`        | `null`                        |
| classes, interfaces, `func` | none: the value must be given |

```go
let u User                 // error: User has no zero value
let u ?User                // fine: u == null
```

### A variable in its own initializer

A variable exists from the start of its declaration, as in JS. A function in its initializer runs
after the initializer, so it can use the variable:

```go
const timer = setInterval(() => {
    if done() {
        clearInterval(timer)
    }
}, 1000)

const fact = func(n number) number {
    return n <= 1 ? 1 : n * fact(n - 1)
}
```

The same holds for event handlers in markup: `const close = <button onClick={close.remove()}>`.

The body of such a function is checked once the variable has its type. That works when the type of
the function is known without its body: a `func` literal, an event handler, or a callback whose
parameter types and result come from the call. Otherwise the type of the variable is written:

```go
const fib = (n number) => fib(n - 1)            // error: give "fib" a type
const fib func(number) number = n => n < 2 ? n : fib(n - 1) + fib(n - 2)
```

A use outside of functions reads the variable before it has a value: in JS that is a
`ReferenceError`, here a compile error. In Go, `x := x + 1` in a nested scope uses the outer `x`;
in MangoScript, as in JS, it is the new variable, so the compiler asks for another name:

```go
const x = 1
func f() {
    const x = x + 1    // error: "x" here is the new variable, which has no value yet
}
```

The rule is that of JS because the declaration compiles to the same JS declaration; the compiler
only reports at compile time what would fail at run time.

## 3. Types

| MangoScript    | Values                                       | In JS             |
| -------------- | -------------------------------------------- | ----------------- |
| `number`       | numbers                                      | `number`          |
| `string`       | strings                                      | `string`          |
| `bool`         | `true`, `false`                              | `boolean`         |
| `any`          | anything, unchecked                          | —                 |
| `error`        | an error or `null`                           | `Error` or `null` |
| `[]T`          | an array                                     | `Array`           |
| `?T`           | a value of type `T` or `null`                | a value or `null` |
| `func(A, B) R` | a function                                   | a function        |
| `A \| B`       | a value of type `A` or of type `B`           | a value           |
| `"all"`, `42`  | exactly that value                           | a value           |
| `{ x number }` | an object with these fields                  | an object         |
| a class name   | an instance of the class                     | an instance       |
| an interface   | any value with the needed fields and methods | —                 |

The type goes after the name, without a colon: `x number`, `xs []string`, `cb func(number) bool`,
`user ?User`.

Typing is **structural**, as in TypeScript: a value fits a type if it has all the needed fields and
methods of the needed types.

### Type declarations

```go
type ID string
type Handler func(string) bool
type Pair { first, second number }
```

`type` gives a type another name: `ID` and `string` are interchangeable (in Go they would be
different types). The shape of objects is usually described with interfaces (section 8).

### Union and literal types

```go
type Filter "all" | "active" | "done"

func show(value string | number) string {
    if typeof value == "string" {
        return value.toUpperCase()
    }
    return value.toFixed(2)         // here value is already a number
}
```

- **`A | B`** is a value of one of the types. Parentheses group: `[](string | number)`,
  `?(A | B)`. `?` applies to the nearest type, and `func() A | B` is a function that returns a
  union.
- **A literal type** `"all"`, `42` or `true` allows only that value. A union of literals catches
  typos: `filter = "activ"` and `filter == "activ"` are errors.
- **A member of a union** can be used if every type has it: `string | number` has `toString()` but
  not `length`. To get to the rest, the type is narrowed (section 11).
- A literal in code gets a literal type only where one is expected: `let f = "all"` is a `string`,
  and `let f Filter = "all"` is `"all"`.
- Branches of `?:`, array items and the different `return`s of a function without a declared
  result give a union when their types differ: `[1, "a"]` is `[](number | string)`.
- Unions and literal types have no zero value: `let f Filter` must be initialized.

### Generics

Type parameters go in square brackets after the name, as in Go:

```go
func first[T any](xs []T) ?T {
    return xs.length > 0 ? xs[0] : null
}

interface Box[T] {
    value T
}

type Pair[A, B any] { first A; second B }

class Stack[T] {
    private items []T
    push(item T) { this.items.push(item) }
    pop() ?T { return this.items.pop() ?? null }
}

const n = first([1, 2, 3])              // ?number
let b Box[string] = { value: "a" }
let s Stack[number] = new Stack()
```

- **A constraint** goes after the name: `[T Named]` means `T` must fit `Named`, and values of type
  `T` have the members of `Named`. `any` means no constraint, and then `T` has no members. Several
  names in a row share one constraint: `[K, V any]`. Interfaces, classes and `type` may leave the
  constraint out: `interface Box[T]`.
- **Type arguments** are written only in types: `Box[number]`, `Pair[string, ?number]`. In calls
  and in `new` they are inferred from the arguments, and failing that, from the expected type:
  `let xs []number = empty()`. There is no explicit `first[number](xs)`: in an expression it could
  not be told from an index. If there is nothing to infer from, it is an error: `let s = new Stack()`.
- Inside a function, `T` is a type of its own: `return 1` in a function with the result `T` is an
  error. `T` has no zero value.
- A type can refer to itself: `interface Tree[T] { value T; children []Tree[T] }`.
- `Box[number]` and `Box[string]` are different types, and so are `Stack[number]` and
  `Stack[string]`.
- A generic class cannot be extended yet: `extends Stack[number]` would be an index in JS. Methods
  with type parameters of their own (`map[U any](...)`) are not supported yet either.
- In JS, generics are erased, as in TypeScript.

### null and null safety

The language has one "empty" value, `null`; MangoScript has no `undefined`. An ordinary `==`
compiles to `===`, but a comparison with `null` stays loose: `x == null` → `x == null`. So it also
catches `undefined` coming from JS code.

`null` can be assigned only to `?T`, `error` and `any`. To use a field or a method of a value of
type `?T`, the type must first be narrowed:

```go
func findUser(id number) ?User { ... }

const u = findUser(1)
console.log(u.name)                  // error: u may be null
console.log(u?.name)                 // fine: the type is ?string
console.log(u?.name ?? "anonymous")  // fine: the type is string

if u != null {
    console.log(u.name)              // here u is a User
}

if u == null {
    return
}
console.log(u.name)                  // and here: on null the function has returned
```

- Narrowing works for local variables and parameters. The value of a field (`this.user`) is first
  put into a `const`.
- `error` always allows `null`; there is no need to write `?error`.
- `xs[i]` has the type `T`, not `?T`: the compiler does not catch indexes out of bounds (nor does
  TypeScript by default).
- Values of type `any`, including everything imported from JS modules without types, are not
  checked.

## 4. Functions

```go
func add(a, b number) number {
    return a + b
}

func greet(name string) {          // without a result type it returns nothing
    console.log(`Hello, ${name}`)
}
```

```js
function add(a, b) {
  return a + b;
}

function greet(name) {
  console.log(`Hello, ${name}`);
}
```

Adjacent parameters of the same type can be grouped: `a, b number` is the same as
`a number, b number`.

An object result type goes in parentheses, or its `{` could not be told from the function's body:
`func origin() ({ x, y number }) { ... }`.

### Multiple results

```go
func divmod(a, b number) (number, number) {
    return Math.floor(a / b), a % b
}

const q, r = divmod(17, 5)
const _, rest = divmod(17, 5)      // _ skips a value
```

```js
function divmod(a, b) {
  return [Math.floor(a / b), a % b];
}

const [q, r] = divmod(17, 5);
const [, rest] = divmod(17, 5);
```

The rules are those of Go:

- several values can only be returned with `return` and unpacked at once into variables in
  `let`/`const` or in an assignment;
- the number of variables must match the number of values;
- `divmod(17, 5) + 1` is a compile error.

### Anonymous functions

```go
const square = func(x number) number { return x * x }
const sum = (a, b number) => a + b
const doubled = nums.map(x => x * 2)      // the type of x comes from the context
```

Arrow functions are as in JS, with Go-style types. If the type of a parameter cannot be inferred
from the context, it must be written.

A `func` literal compiles to an arrow function too, so `this` inside it is the `this` of the
surrounding method, not a new one as with `function` in JS.

### defer

`defer` postpones a call until the function exits: on `return`, at the end of the body or on an
exception.

```go
func readConfig(path string) (string, error) {
    const fd = fs.openSync(path, "r")
    defer fs.closeSync(fd)

    const text = fs.readFileSync(fd, "utf8")
    if text == "" {
        return "", error("empty config")
    }
    return text, null
}
```

```js
function readConfig(path) {
  const fd = fs.openSync(path, "r");
  try {
    const text = fs.readFileSync(fd, "utf8");
    if (text === "") {
      return ["", new Error("empty config")];
    }
    return [text, null];
  } finally {
    fs.closeSync(fd);
  }
}
```

The rules are those of Go:

- the function and its arguments are evaluated at the `defer`, and the call happens on exit;
- several deferred calls run in reverse order;
- if a deferred call throws, the others still run;
- `defer` belongs to the whole function, not to a block: a `defer` in a loop adds a call on every
  iteration, and all of them run when the function exits;
- `defer` is allowed only inside functions and methods;
- inside `defer { ... }` there can be no `return`, and `break` and `continue` only in loops nested
  in it: deferred code cannot change how the function ended.

```go
func countdown() {
    for let i = 0; i < 3; i++ {
        defer console.log(i)
    }
}
// countdown() prints 2, 1, 0
```

For several actions there is a block form; its content runs as a whole on exit:

```go
defer {
    conn.close()
    console.log("connection closed")
}
```

If all the `defer`s are at the top level of the function's body, the compiler writes nested
`try/finally`, as in the example above. If a `defer` is inside an `if` or a loop, the deferred calls
are collected in a stack and run in `finally`.

## 5. Conditions and loops

### if

```go
if x > 0 {
    console.log("positive")
} else if x < 0 {
    console.log("negative")
} else {
    console.log("zero")
}
```

No parentheses around the condition, braces are required. The condition must be a `bool`: unlike
JS, there is no truthy/falsy. `if count {` is an error, write `if count > 0 {`, and instead of
`if user {` write `if user != null {`.

An object literal in the header of `if`, `for` or `switch` goes in parentheses, or its `{` would be
taken for the start of the block (the same rule as in Go).

### for, the only loop

| MangoScript                     | JS                                          |
| ------------------------------- | ------------------------------------------- |
| `for let i = 0; i < n; i++ { }` | `for (let i = 0; i < n; i++) { }`           |
| `for x in items { }`            | `for (const x of items) { }`                |
| `for i, x in items { }`         | `for (const [i, x] of items.entries()) { }` |
| `for cond { }`                  | `while (cond) { }`                          |
| `for { }`                       | `while (true) { }`                          |

`for x in items` goes over the **values**, like `for...of` in JS or `for x in` in Python and Rust,
not over the keys like `for...in` in JS. In Go, `for i := range xs` with one variable gives the
index; here one variable gets the value, and two get the index and the value.

`break` and `continue` work as usual.

### switch

```go
switch cmd {
case "start", "run":
    start()
case "stop":
    stop()
default:
    console.log("unknown command")
}
```

```js
switch (cmd) {
  case "start":
  case "run":
    start();
    break;
  case "stop":
    stop();
    break;
  default:
    console.log("unknown command");
}
```

Every `case` ends with an implicit `break`; several values are separated by commas.

`switch` without an expression replaces a long chain of `if`s:

```go
switch {
case score >= 90:
    grade = "A"
case score >= 75:
    grade = "B"
default:
    grade = "C"
}
```

```js
if (score >= 90) {
  grade = "A";
} else if (score >= 75) {
  grade = "B";
} else {
  grade = "C";
}
```

## 6. Errors

Expected errors (wrong input, a file not found) are returned as the last value, of type `error`:

```go
func parsePort(s string) (number, error) {
    const n = Number(s)
    if Number.isNaN(n) || n < 1 || n > 65535 {
        return 0, error(`invalid port: ${s}`)
    }
    return n, null
}

const port, err = parsePort(input)
if err != null {
    console.error(err.message)       // inside the if, err is an Error, not null
}
```

```js
function parsePort(s) {
  const n = Number(s);
  if (Number.isNaN(n) || n < 1 || n > 65535) {
    return [0, new Error(`invalid port: ${s}`)];
  }
  return [n, null];
}

const [port, err] = parsePort(input);
if (err != null) {
  console.error(err.message);
}
```

`error(msg)` creates `new Error(msg)`.

Exceptions remain for JS code that throws and for real emergencies:

```go
let config any
try {
    config = JSON.parse(text)
} catch e {
    console.error("bad config:", e)
} finally {
    console.log("done")
}

throw error("unreachable")
```

`catch` is written without parentheses, and `e` has the type `any`.

## 7. Classes

Classes as in JS and TypeScript, with Go-style types. Methods are declared without `func`, like
methods of JS classes.

```go
class User {
    name string
    private age number             // the zero value: 0
    tags []string                  // the zero value: []
    static count = 0

    constructor(name string, age number) {
        this.name = name
        this.age = age
        User.count++
    }

    greet() string {
        return `Hi, I'm ${this.name}`
    }

    isAdult() bool {
        return this.age >= 18
    }
}

class Admin extends User {
    protected level number

    constructor(name string, age, level number) {
        super(name, age)
        this.level = level
    }

    greet() string {
        return `${super.greet()} (admin)`
    }
}

const ann = new User("Ann", 30)
```

```js
class User {
  name = "";
  age = 0;
  tags = [];
  static count = 0;

  constructor(name, age) {
    this.name = name;
    this.age = age;
    User.count++;
  }

  greet() {
    return `Hi, I'm ${this.name}`;
  }

  isAdult() {
    return this.age >= 18;
  }
}
```

- `private`, `protected` and `public` (the default) are checked only by the compiler, as in
  TypeScript. They do not get into JS, so JS code can reach the fields.
- Visibility is set by modifiers, not by the case of the first letter as in Go.
- Fields are reached through `this` inside methods, as in JS.
- Methods can return several values.
- A field without a value gets the zero value of its type. If the type has none (a class, an
  interface, a function), the field must be assigned in the constructor.

## 8. Interfaces

An interface describes the shape of a value: its fields and methods. As in TS, it exists only at
compile time.

```go
interface Shape {
    name string
    area() number
}

interface Point {
    x, y number
    label ?string                  // an optional field: it may be left out
}

class Circle implements Shape {
    name = "circle"
    r number

    constructor(r number) {
        this.r = r
    }

    area() number {
        return Math.PI * this.r ** 2
    }
}

func describe(s Shape) string {
    return `${s.name}: ${s.area()}`
}

describe(new Circle(2))               // the class fits Shape
const p Point = { x: 1, y: 2 }        // the object literal fits Point
```

`implements` is optional: a class fits an interface if it has the needed fields and methods.
`implements` just asks the compiler to check that where the class is declared.

## 9. Modules

```go
import { readFileSync, writeFileSync as write } from "node:fs"
import * as path from "node:path"
import express from "express"
import "./setup.mango"

export func greet(name string) string {
    return `Hello, ${name}`
}
export const VERSION = "0.1.0"
export class User { ... }
export interface Point {
    x, y number
}
```

Imports and exports become ES modules one to one; `export interface` and `export type` disappear at
compile time.

- A name used only as a type (an imported interface, for example) is removed from the `import`:
  there is no such value at runtime.
- `mango build main.mango` writes `main.js` (and `main.d.ts`, see below) next to the source and
  compiles every `.mango` file it imports the same way. In imports, `.mango` is replaced with
  `.js`: `"./geom.mango"` → `"./geom.js"`. `mango build src/` builds every `.mango` file of a
  folder, and `--out-dir build/` puts the `.js` files into a separate folder with the same
  structure. If any file has errors, no file is written.
- `mango run` compiles the imported `.mango` files on the fly.

### Types from TypeScript

The types of imports that are not `.mango` modules come from TypeScript declarations: packages with
`types` in `package.json` or with `@types/*`, `.ts` files and Node modules (`node:fs`, `node:http`
from `@types/node`). The TypeScript compiler (the `typescript` package) reads them; it is loaded
only when there is such an import. A module without declarations, such as a JS file without a
`.d.ts`, stays `any`, without an error.

```go
import { readFileSync } from "node:fs"
import { createServer, IncomingMessage, ServerResponse } from "node:http"

const text = readFileSync("a.txt", "utf8")      // string
const bytes = readFileSync("a.txt")             // Buffer

func handle(request IncomingMessage, response ServerResponse) {
    const url string = request.url              // error: url may be null (?string)
}
```

How TypeScript types become MangoScript types:

| TypeScript                                      | MangoScript                                  |
| ----------------------------------------------- | -------------------------------------------- |
| `boolean`, `string`, `number`, literals, unions | `bool`, `string`, `number`, literals, unions |
| `T \| undefined`, `T \| null`, `x?: T`          | `?T`                                         |
| `T[]`, `Array<T>`; a tuple `[A, B]`             | `[]T`; `[](A \| B)`                          |
| `void` as a result                              | a function without a result                  |
| an interface, an object type, an intersection   | an interface                                 |
| a class                                         | a class: `new`, `extends`, `instanceof`      |
| `Box<T>`, `function first<T>(...)`              | generics: `Box[T]`, inferred type arguments  |
| overloads                                       | a call picks the first signature that fits   |
| `enum`                                          | a union of literals                          |
| `[key: string]: T`                              | unknown members have the type `T`            |
| `unknown`, `object`, `symbol`, `bigint`         | `any`                                        |
| conditional and mapped types TS did not reduce  | `any`                                        |

- `import x from "pkg"` is the default export; for modules with `export =` it is the value itself,
  and named imports are its properties: `import { join } from "node:path"`.
- A type parameter with a default may be left out: `Buffer` is `Buffer[ArrayBufferLike]`. Such a
  class can be extended: `class Bus extends EventEmitter`.
- Constraints of type parameters from a `.d.ts` are not checked.
- Types cannot reach a type inside a namespace (`http.Server`): it is imported by name.
- The playground on the site works in the browser without the `typescript` package, so such imports
  are `any` there.

### Declarations for TypeScript

`mango build` with type checking writes a `.d.ts` next to each `.js`, so TypeScript code imports a
MangoScript module with types. With `--no-check` there are no declarations: without checking, the
types are unknown.

```go
export type Filter "all" | "active" | "done"

export func divide(a, b number) (number, error) { ... }

export class Stack[T] {
    private items []T
    push(item T) { ... }
    pop() ?T { ... }
}
```

```ts
export type Filter = "all" | "active" | "done";
export declare function divide(a: number, b: number): [number, Error | null];
export declare class Stack<T> {
    private items;
    push(item: T): void;
    pop(): T | null;
}
```

- `bool` → `boolean`, `?T` → `T | null`, `error` → `Error | null`, `[]T` → `T[]`; a field of type
  `?T` may be left out: `note?: string | null`.
- Several results → a tuple `[A, B]`: in JS, too, the function returns an array.
- Parameter names come from the code and types from the checking, so inferred types
  (`const n = 1`) get into the declarations too.
- Interfaces, `type`s and classes are declared even when not exported: exported functions may use
  them. Components do not exist in JS, nor in the declarations.
- Imports are repeated with `.js` instead of `.mango`, so that the imported names can be used in
  types.

### Markup

Markup in code creates real DOM elements, with no virtual DOM:

```go
const name = "to the home page"
const link = <a href="/" class="nav">Link {name}</a>     // HTMLAnchorElement
```

```js
const link = document.createElement("a");
link.href = "/";
link.className = "nav";
link.append("Link ", name);
```

- **Syntax as in JSX:** attributes `href="/"`, `href={url}`, `disabled`, `{...attrs}`; children are
  text, `{expression}` and elements; a fragment is `<>...</>`. Attribute names are the HTML ones:
  `class`, `for`.
- **Types:** `<input>` is an `HTMLInputElement`, `<a>` an `HTMLAnchorElement` and so on. Attributes
  that match DOM properties are checked against the property's type. Children are strings, numbers,
  nodes, arrays of them or `?T`; `null` shows nothing.
- **Events:** a function name, `obj.method` or a function literal is the handler. Anything else is
  code that runs on the event, with the variable `event`: `onClick={count++}`,
  `onSubmit={event.preventDefault(); send()}`. So `onClick={save()}` calls `save` on a click.
- **Where markup can start.** `<` at the start of an expression starts markup; after a value it is
  a comparison. The opening tag goes on the same line as `return`.
- **Conditions and loops** are written inside `{...}` as ordinary `if`, `for` and `switch`. The
  elements in their blocks become the content; besides elements, the blocks can hold only nested
  `if` / `for` / `switch` and `const`:

  ```go
  <ul>{for i, product in products {
      if product != null {
          <Product {...product} />
      }
  }}</ul>
  ```

### Components

A component exists only at compile time: every use of it is replaced by its code.

```go
comp Card(title string, kind string = "info", children Content) {
    return <section class={kind}>
        <h2>{title}</h2>
        {children}
    </section>
}

document.body.append(<Card title="Profile"><p>Text</p></Card>)
```

- **Declaration.** `comp Name(properties) { ...; return <markup> }`, only at the top level of a
  module. The name starts with a capital letter. The body ends with a `return` of markup.
- **An early `return`** returns markup too: `if index > 2 { return <div>end</div> }`. The body runs
  once, when the component is created, so the choice between the `return`s is made once: if what
  the condition reads changes later, the component stays the same. For markup that changes with
  state, use `{if ...}` in the markup.
- **Properties.** These are parameters in Go syntax; only they can have default values. A property
  of type `?T` or with a default value may be left out. Attributes are checked like the arguments
  of a call: an extra attribute or a missing required property is an error.
- **`children Content`** gets the markup between the tags.
- **Spread** `<Product {...product} />` passes the object's fields named like the properties; other
  fields are ignored, and attributes after the spread override it.
- **Function properties** (`onPress func()`) take code by the same rule as `on*` of elements.
- **Properties are read-only.** To change the parent's state, pass a function property.
- **There is no component in JS:** its code is inlined as a block where it is used, and the values
  of the attributes are computed before that block. The exception is recursive components, see
  below.
- **Recursive components** (a tree, nested comments) are not inlined but compiled to a function.
  Some use on the cycle must be under a condition (`if`, `for`, a branch of `?:`), or the recursion
  never ends: that is a compile error.
- **Not supported yet:** exporting components from a module, `derived` and `effect`.

**State.** `state` declares a variable that the markup depends on. It is declared like `let`, but
only at the top level of a component's body:

```go
comp Counter(initialValue number) {
    state count = initialValue
    return <button onClick={count++}>Clicked {count} times</button>
}
```

```js
let count = initialValue;
const $$button3 = document.createElement("button");
$$button3.addEventListener("click", () => {
  count++;
  $$text4.data = count;
});
const $$text4 = document.createTextNode(count);
$$button3.append("Clicked ", $$text4, " times");
```

- **What updates.** The markup that the component creates once: what it returns and the elements
  declared at the top level of its body (`const input = <input />`). Text and attributes that read
  the state are updated in place. Nodes that depend on it (`{items.map(...)}`,
  `{ok ? <b /> : null}`) are created again. A property of a child component that gets the state is
  updated too.
- **What counts as a change:** assignment and `++` of the variable or its fields
  (`user.name = "Ann"`), the mutating methods of arrays (`push`, `splice`, `sort`…) and methods of
  objects, except known reading ones. Changes through variables that point into the state
  (`for todo in todos`, `todos.map(todo => ...)`) are seen too. Changes inside functions the state
  was passed to are not: then the assignment `todos = todos` helps.
- **When.** Changes in event handlers and in the component's functions update the markup right
  away. Changes in the component's body itself, before `return`, update nothing: there is no markup
  yet, and it will be created with the new values. Neither do changes in rendering code: in markup
  expressions and in the functions they call.

Inside a component, `{if ...}`, `{for ...}` and `{switch ...}` that depend on state update too: a
branch is created again only when the choice changes, and the blocks of a list are found by the
array item itself and moved on changes, not created again.

**Two-way binding.** `bind:value={name}` on `<input>`, `<textarea>` and `<select>` and
`bind:checked={done}` on `<input>` show the variable's value and write what the user entered into
it. Anything assignable can be bound: a variable or a field. The type is `string`, `number` (only
for `<input type="number">` and `type="range"`) or `bool` for `checked`.

**Mounting.** `mount() { ... }` at the top level of a component's body runs once its markup is on
the page. The function it returns runs when `{if}`, `{switch}`, `{for}` or a branch of `?:` in
markup removes the markup:

```go
comp Clock() {
    state time = new Date().toLocaleTimeString()
    mount() {
        const timer = setInterval(() => {
            time = new Date().toLocaleTimeString()
        }, 1000)
        return () => clearInterval(timer)
    }
    return <p>It is {time}</p>
}
```

- **For every instance.** `mount` runs for every created component: twice for a list of two
  `<Fruit />`. To do something once for the whole list, write `mount` in the component that creates
  the list.
- **When.** Only when the markup is in the document. That is checked in a microtask after the
  code that created the component: by then `document.body.append(...)` or an `{if}` branch has
  usually inserted the markup, and the browser has not drawn a frame yet, so `focus()` and measuring
  sizes work. Markup created earlier and inserted later (`const card = <Card />`, then
  `document.body.append(card)` in a timer) mounts when it is inserted: while some markup waits, a
  `MutationObserver` watches the document. If `{if}`, `{switch}` or `{for}` removes the markup
  before that, `mount` does not run.
- **The body of `mount`** is a function that runs later, like an event handler: changes of state in
  it update the markup, and `return` belongs to it, not to the component.
- **What it returns:** nothing, a function without parameters that stops everything, or `null` if
  there is nothing to stop.
- **Who runs the cleanup.** `{if}`, `{switch}` and `{for}` blocks know which components were
  created in them, nested blocks included, and run their cleanup when they remove them. Markup that
  the program inserted by itself (`document.body.append`) and removes by itself does not: its
  cleanup does not run.
- `mount` can be written several times; they run in order.
- `mount` is a keyword only at the start of a statement in a component's body: a function named
  `mount` elsewhere is an ordinary function.

```js
$$mount(() => {
  const timer = setInterval(() => { ... }, 1000);
  return () => clearInterval(timer);
});
```

**Web components.** `@html-tag` before `comp` makes a component a custom element as well, so it
works in plain HTML, in other frameworks and from JS. The tag is the component's name in kebab case,
or the one given in the decorator:

```go
@html-tag comp mainPage() { ... }               // <main-page>
@html-tag("app-card") comp Card(title string) { ... }   // <app-card>
```

- **The name** follows the rules of HTML: lowercase letters, digits, `-`, `.` and `_`, starting
  with a letter, with at least one hyphen, and not one of the names HTML reserves (`font-face`...).
  A name that breaks them, or a tag used by two components, is a compile error. Without a name in
  the decorator, the component may start with a lowercase letter: `@html-tag comp mainPage()`.
- **Rendering.** The element creates the component's markup in its shadow root when it is connected
  to the document. When it is disconnected and not inserted back in the same task, the markup is
  removed and the functions returned by `mount()` run; moving the element keeps its markup and
  state. `children` is a `<slot>`.
- **Properties.** Every property except `children` is a JS property of the element; setting it
  updates the markup. Properties of type `string`, `number` or `bool` (also nullable, literal
  types and their unions) have attributes too: `itemCount` is `item-count`. The attribute is
  converted by the type: a string as it is, a number with `Number()`, a bool is `true` when the
  attribute is there. A removed attribute leaves the default value. Arrays, objects and functions
  are only JS properties.
- **Missing properties.** An element written in HTML has no properties until they are set, so a
  property without a default value gets its zero value (`""`, `0`, `false`, `[]`, `null`). A
  property whose type has no zero value needs a default value or a nullable type. Properties cannot
  have the names of `HTMLElement` properties that the element needs: `id`, `style`, `hidden`,
  `className`, `slot`...
- **In markup of the same module** `<app-card title="Hi" item-count={2} />` sets the properties
  directly, so they are checked like the properties of a component and may be objects or functions.
- **Definition.** `customElements.define` is called at the end of the module, when the names the
  component uses have their values. Properties set on an element before that are kept.

```js
class $$CardElement extends HTMLElement {
  static observedAttributes = ["title"];
  connectedCallback() { /* $$Card(...) into this.shadowRoot */ }
  disconnectedCallback() { /* the cleanup of mount() */ }
  attributeChangedCallback(name, old, value) { /* this.title = value ?? undefined */ }
  set title(value) { /* updates the markup */ }
}
customElements.define("app-card", $$CardElement);
```

The full design, reactivity included, is in [docs/components.md](components.md).

## 10. Operators: differences from JS

| MangoScript       | JS          | Note                                                      |
| ----------------- | ----------- | --------------------------------------------------------- |
| `a == b`          | `a === b`   | the language has no loose comparison                      |
| `a != b`          | `a !== b`   |                                                           |
| `x == null`       | `x == null` | stays loose: catches both `null` and `undefined`          |
| `a = b`, `a += b` | the same    | only as a statement: `f(a = 1)`, `a = b = c` are errors   |
| `i++`, `i--`      | the same    | only as a statement: `a = i++` is an error; no `++i`      |
| `&&`, `\|\|`, `!` | the same    | only for `bool`; a default value is written with `??`     |
| `a + b`           | the same    | numbers or strings; `"a" + 1` is an error, use a template |

The rest is as in JS: arithmetic, comparisons, bitwise operations, `**`, `??`, `?.`, `? :`,
`typeof`, `instanceof`, `new`, spread `...`, indexing `xs[i]`.

The language has no `var`, `function`, `===`, `while`, `do...while`, `for...in`, `with` or comma
operator.

Only a function call or `new` can be a statement on its own, as in Go: a line `a + b` or
`user.name` by itself is an error. This catches typos and a line break before a binary operator:

```go
const total = price
    + tax              // error: there is already a ; after price, and "+ tax" does nothing
```

## 11. Type checking

The compiler checks types before generating JS; a program with type errors does not compile
(`mango build --no-check` skips the check).

```
hello.mango:4:17: error: cannot use ?User as User: it may be null, check it first
hello.mango:7:13: error: "u" may be null: check it with "if u != null" or use "?."
hello.mango:9:11: error: cannot add string and number: use a template string, e.g. `${a}${b}`
```

### What is checked

- The types of values in declarations, assignments, arguments and `return`; the number of arguments
  and results; `missing return` if a function with a result can reach the end of its body.
- Null safety: using fields and methods of `?T`, passing `?T` where `T` is expected.
- The conditions of `if`/`for`/`?:` and the operands of `&&`, `||`, `!` must be `bool`.
- Operators: `+` for two numbers or two strings, arithmetic only for numbers, `==` only for
  comparable types.
- Names: unknown variables and types, assignment to constants and loop variables, `_` as a value.
- Classes: `private`/`protected` visibility, the constructor's arguments, a `super(...)` call in the
  constructor of a subclass, compatible overridden methods, `implements`, fields without a zero
  value that are not assigned.
- Object literals: missing fields, extra fields (a likely typo), the types of fields.

### Narrowing

The type of a local variable or a parameter narrows from `?T` to `T`:

- inside `if x != null { ... }` and in the branches of `?:`;
- after `if x == null { return }` (and `throw`, `break`, `continue`);
- on the right side of `x != null && x.ok` and `x == null || x.ok`;
- in the body of the loop `for x != null { ... }`;
- after an assignment of a value that cannot be `null`.

Unions narrow the same way:

- `typeof x == "string"` keeps the members for which `typeof` gives `"string"`, and `!=` the rest;
  for `any` it narrows to `string`, `number` or `bool`;
- `x instanceof Point` keeps the instances of `Point` and removes them in the false branch;
- `filter == "all"` narrows a union of literals to `"all"`, and `!=` removes `"all"`;
- in `switch filter { case "active": ... }`, in each branch `filter` is the literals of its `case`,
  and in `default` those that matched no `case`.

An assignment to a variable ends its narrowing. In a loop, variables that change in it are not
narrowed. In a closure, narrowing is kept only for constants and variables that are never
reassigned.

### Type inference

- `let x = value` gets the type of the value; `null` and `[]` without a declared type are errors.
- The parameters of an arrow function take their types from the context: `xs.map(x => x * 2)`,
  `apply(n => n > 0)`. The result of an arrow function is inferred from its body.
- The type of array items is the common type of all of them: `[1, null]` is `[]?number`.

### Built-in JS types

The types of the JS standard library and the DOM come from TypeScript's lib files (`lib.es2024`,
`lib.dom`) and global `@types` (for example, `process` and `Buffer` from `@types/node`):

- `document`, `window`, `fetch`, `Promise`, `Map`, `Set`, `Date`, `URL`, `Object`… are typed:
  `document.getElementById("app")` is a `?HTMLElement`, `new Map()` with
  `let m Map[string, number]` is a `Map[string, number]`, and `m.get(k)` is a `?number`;
- `<input>` creates an `HTMLInputElement` with all the members from `HTMLElementTagNameMap`;
- `event` in `onClick` is a `PointerEvent`, in `onKeyDown` a `KeyboardEvent` (from
  `HTMLElementEventMap`), and `event.currentTarget` is the element itself. `event.target` is a
  `?EventTarget`, as in TypeScript;
- `x instanceof HTMLInputElement` narrows the type, although in lib.dom it is a constructor, not a
  class;
- strings, numbers and arrays have all the methods of `String`, `Number` and `Array<T>`.

Some types are written by hand and take precedence over lib: `console`, `Math`, `JSON`, `Number`,
`String`, `Boolean`, `parseInt`, `parseFloat`, `setTimeout`/`setInterval`, `Error`, `error` and the
main methods of strings, numbers and arrays (`find`, `pop` and `at` return `?T`). So a program is
checked the same way in Node and in the browser.

In the browser (the playground on the site) there is no TypeScript compiler: only the hand-written
types work there, and the other globals (`document`, `fetch`, `Map`…) are `any`.

The types from imported `.mango` modules are checked: the compiler reads those modules itself. The
types of other imports come from TypeScript declarations (section 9).

## 12. Example

[examples/hello.mango](../examples/hello.mango)

## 13. Not in v0

- **`async func` and `await`.**
- **`map[K]V`**, compiled to `Map`: `m[k]` → `m.get(k)`, `m[k] = v` → `m.set(k, v)`.
- **Classes:** getters and setters, `readonly`, abstract classes, constructor parameter properties
  (`constructor(private name string)`).
- **`if` with an initializer:** `if const v, err = f(); err != null { }`.
- **Labels** for `break`/`continue`.
- **Regular expression literals** `/.../g`. For now, `new RegExp("...", "g")`.
- **Source maps.**
- **A WASM backend** for a subset of the language (numbers, arrays, classes).

## Open questions

1. **Functions that return an object and an error.** A class has no zero value, so a function that
   may return an error must return `(?User, error)`. The caller then needs two checks:

   ```go
   const user, err = loadUser(id)
   if err != null {
       return
   }
   if user != null {                 // the second check is only for the type
       console.log(user.name)
   }
   ```

   Proposal: allow the signature `(User, error)` with `return null, err` and consider the value not
   `null` after the check `err != null`. Nothing changes at runtime; it is a rule of type checking
   only.

## Implementation order

1. ~~A lexer that inserts `;` automatically.~~
2. ~~A parser → AST.~~
3. ~~JS generation.~~
4. ~~Type checking.~~
5. The features from "Not in v0".
