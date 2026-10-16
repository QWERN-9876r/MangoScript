# MangoScript — draft specification v0

**English** · [Русский](spec.ru.md)

> Status: a draft, anything may change. Unresolved questions are collected under "Open questions".

MangoScript is a language with the semantics of JavaScript, Go-style syntax and static types. Its
main feature is goroutines: `go f(x)` runs a function as a goroutine, on another processor, and
channels and `select` connect goroutines, as in Go (section 5). It compiles to readable JavaScript
(ES modules), and the types are erased at compile time.

## Principles

1. **JS semantics.** The same values, objects, classes, closures, modules and standard library
   (`console`, `Math`, `JSON`, methods of arrays and strings).
2. **Go syntax where it is more convenient:** `func`, the type after the name, multiple results,
   `defer`, zero values, conditions without parentheses, a single `for` loop, `switch` without
   `break`, no semicolons.
3. **Concurrency as in Go.** `go f(x)` runs a function as a goroutine, on another processor, and
   channels and `select` pass values between goroutines. The compiler checks that what goes
   between threads can be copied.
4. **Static types with null safety.** The compiler finds type errors; `null` can only be assigned
   to a type that explicitly allows it. JS code has no types.
5. **Compatibility with JS.** MangoScript can import any JS module, and a compiled module can be
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

- Numbers as in JS: `42`, `3.14`, `1e3`, `0xff`, `1_000_000`; a bigint ends with `n`: `10n`,
  `0xffn`.
- Strings: `"..."`, `'...'` and template strings `` `Hello, ${name}` ``.
- `true`, `false`, `null`.
- Arrays `[1, 2, ...rest]` and objects `{ name: "Ann", age, "content-type": t, ...defaults }`
  (the shorthand `age` and spread are as in JS).

### Keywords

```
func  comp  return  let  const  type  interface  class  extends  new  this  super
if  else  for  in  break  continue  switch  case  default  defer
try  catch  finally  throw  import  export  async  await  go  chan
null  true  false  typeof  instanceof
```

Inside a class declaration `static`, `private`, `protected`, `public` and `implements` are keywords
too, in `import` and `export` so is `from`, at the start of a statement in a component's body
`state`, `derived`, `ref`, `style`, `mount` and `effect`, at the start of a top-level declaration `dec`, after its
parameters `needs`, in a decorator's body `public`, and before `{` at the start of a statement
`select`. Elsewhere they are ordinary names; `get` is
special only in `get(@name.member)`. Reserved
for the future: `map`. Decorators are written before `comp`: `@html-tag` (see
"Web components") and those declared with `dec` (see "Decorators").

After `.` and in object keys, keywords can be used as ordinary names: `xs.map(f)`, `event.type`,
`{ default: 1 }`.

Predeclared identifiers (not keywords, they can be redeclared): the types `number`, `string`,
`bool`, `any`, `error` and the functions `error()` and `close()` (of channels).

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
| `bigint`                    | `0n`                          |
| `string`                    | `""`                          |
| `bool`                      | `false`                       |
| `[]T`                       | `[]` (a new array each time)  |
| `[]byte`                    | an empty `Uint8Array`         |
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

| MangoScript       | Values                                       | In JS             |
| ----------------- | -------------------------------------------- | ----------------- |
| `number`          | numbers                                      | `number`          |
| `bigint`          | whole numbers of any size, `10n`             | `bigint`          |
| `byte`            | a number from 0 to 255                       | `number`          |
| `string`          | strings                                      | `string`          |
| `bool`            | `true`, `false`                              | `boolean`         |
| `any`             | anything, unchecked                          | —                 |
| `error`           | an error or `null`                           | `Error` or `null` |
| `[]T`             | an array                                     | `Array`           |
| `[]byte`          | bytes                                        | `Uint8Array`      |
| `?T`              | a value of type `T` or `null`                | a value or `null` |
| `func(A, B) R`    | a function                                   | a function        |
| `(a A) => R`      | the same function type, written as an arrow  | a function        |
| `comp(a A)`       | a component, which a tag takes from a value  | a function        |
| `A \| B`          | a value of type `A` or of type `B`           | a value           |
| `"all"`, `42`     | exactly that value                           | a value           |
| `{ x number }`    | an object with these fields                  | an object         |
| `{ [string]: T }` | an object used as a map: any key, values `T` | an object         |
| a class name      | an instance of the class                     | an instance       |
| an interface      | any value with the needed fields and methods | —                 |

The type goes after the name, without a colon: `x number`, `xs []string`, `cb func(number) bool`,
`user ?User`.

Typing is **structural**, as in TypeScript: a value fits a type if it has all the needed fields and
methods of the needed types.

- **A function type as an arrow,** `(paths []string) => Shape`, is the same as
  `func([]string) Shape`; the names of the parameters only document them, and `=> void` means no
  result. Parentheses with one type and no arrow still group: `[](string | number)`.
- **An object used as a map,** `{ [string]: number }`, has any keys with values of that type; the
  key is `string` or `number`. An object literal or another object fits it if all its fields do.
  `scores["ann"]` and `scores[name]` are a `number`, and `delete scores[name]` removes a key.

### bigint

```go
let big = 2n ** 64n           // 18446744073709551616n
let zero bigint               // 0n
const third = big / 3n        // the fraction is dropped
const n = Number(big) + 0.5   // a number again
```

`bigint` holds whole numbers of any size, as in JS. A literal ends with `n`: `10n`, `0xffn`,
`1_000n`; it has no fraction or exponent. The zero value is `0n`.

- **It does not mix with numbers** in arithmetic: `big + 1` is an error, since JS throws a
  TypeError there. One of them is converted: `big + 1n`, `BigInt(n)`, `Number(b)`.
- **Comparisons:** `<`, `>`, `<=` and `>=` work between a bigint and a number, as in JS. `==`
  between them is an error: it compiles to `===`, which is always `false` for the two.
- `-b`, `~b`, `b++` and the bit operators work; `+b` and `>>>` are errors, as JS throws there.
- `typeof b` is `"bigint"` and narrows a `number | bigint`. A bigint goes into markup as text and
  to a goroutine as a copy; `JSON.stringify` cannot write one (JS throws).

### []byte

```go
let header []byte = [0x89, 0x50, 0x4e, 0x47]
let empty []byte
const bytes = []byte("mango")
const text = string(bytes)
```

```js
let header = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
let empty = new Uint8Array();
const bytes = new TextEncoder().encode("mango");
const text = new TextDecoder().decode(bytes);
```

`[]byte` is a `Uint8Array`, as a byte slice in Go, and `byte` is a `number` from 0 to 255 (the
range is not checked, as for other numbers). `data[i]` reads and writes a `byte`, and the methods
are those of `Uint8Array`: `subarray`, `slice`, `set`, and no `push`, since its length is fixed.

- **A list of numbers** where a `[]byte` is expected becomes one; the zero value is an empty
  `Uint8Array`.
- **Text and bytes** convert as in Go, in UTF-8: `[]byte("text")` and `string(bytes)`. They are
  the only conversions written with a type: `string(65)` is an error (in Go it would be `"A"`), and
  other values use `String(x)` or a template string. A program that declares a type `byte` or a
  value `string` uses its own.
- A `[]byte` goes to a goroutine as a copy, or without one with `transfer(data)`.

### Type declarations

```go
type ID string
type Handler func(string) bool
type Pair { first, second number }
```

`type` gives a type another name: `ID` and `string` are interchangeable (in Go they would be
different types). The shape of objects is usually described with interfaces (section 9).

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
  not `length`. To get to the rest, the type is narrowed (section 12).
- A literal in code gets a literal type only where one is expected: `let f = "all"` is a `string`,
  and `let f Filter = "all"` is `"all"`.
- Branches of `?:`, array items and the different `return`s of a function without a declared
  result give a union when their types differ: `[1, "a"]` is `[](number | string)`.
- Unions and literal types have no zero value: `let f Filter` must be initialized.
- **A field by a key whose value is known:** `point["x"]`, or `point[axis]` with
  `axis "x" | "y"`, is the field (or the union of the fields) of the object. A key that is not a
  field is an error.

### Generics

Type parameters go in angle brackets after the name, as in TypeScript, and a constraint follows
its parameter, as in Go:

```go
func first<T any>(xs []T) ?T {
    return xs.length > 0 ? xs[0] : null
}

interface Box<T> {
    value T
}

type Pair<A, B any> { first A; second B }

class Stack<T> {
    private items []T
    push(item T) { this.items.push(item) }
    pop() ?T { return this.items.pop() ?? null }
}

const n = first([1, 2, 3])              // ?number
let b Box<string> = { value: "a" }
let s Stack<number> = new Stack()
```

- **A constraint** goes after the name: `<T Named>` means `T` must fit `Named`, and values of type
  `T` have the members of `Named`. `any` means no constraint, and then `T` has no members. Several
  names in a row share one constraint: `<K, V any>`. Interfaces, classes and `type` may leave the
  constraint out: `interface Box<T>`.
- **Type arguments** are written only in types: `Box<number>`, `Pair<string, ?number>`. In calls
  and in `new` they are inferred from the arguments, and failing that, from the expected type:
  `let xs []number = empty()`. There is no explicit `first<number>(xs)`: in an expression it could
  not be told from a comparison. If there is nothing to infer from, it is an error:
  `let s = new Stack()`.
- Inside a function, `T` is a type of its own: `return 1` in a function with the result `T` is an
  error. `T` has no zero value.
- A type can refer to itself: `interface Tree<T> { value T; children []Tree<T> }`.
- `Box<number>` and `Box<string>` are different types, and so are `Stack<number>` and
  `Stack<string>`.
- A generic class cannot be extended yet: the base after `extends` is a value, as in JS, so
  `extends Stack<number>` cannot be written. Methods with type parameters of their own
  (`map<U any>(...)`) are not supported yet either.
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

## 5. Concurrency

JavaScript runs a program in one thread. MangoScript keeps that thread for waiting and gives the
work that keeps a processor busy to other threads, with the means of Go: an async function waits for
a timer or the network in the same thread, `go f(x)` runs a function as a goroutine, on another
processor, and channels and `select` pass values between goroutines in any thread. The compiler
checks that what goes to another thread can be copied there.

### Async functions

```go
async func loadText(url string) (string, error) {
    const response = await fetch(url)
    if !response.ok {
        return "", error(`HTTP ${response.status}`)
    }
    return await response.text(), null
}

const text, err = await loadText("/hello.txt")
```

```js
async function loadText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    return ["", new Error(`HTTP ${response.status}`)];
  }
  return [await response.text(), null];
}

const [text, err] = await loadText("/hello.txt");
```

`async` is written before `func`, before a method of a class (`async load() string`), before a
`func` literal and before an arrow function (`async x => ...`).

- **The result types are what `return` gives;** the function itself returns a Promise of them:
  `loadText` has the type `func(string) Promise<(string, error)>`. So the results are written as
  in any function, also several of them; `Promise<string>` as the result of an async function is
  an error.
- **`await p` waits for the Promise and gives its value.** The results of an async function are
  unpacked from it as from a call: `const text, err = await loadText(url)`. `await` of a value
  that is not a Promise gives the value itself, as in JS.
- **Where `await` is allowed:** in async functions and at the top level of a module, since
  modules are ES modules. Not in `defer`: deferred code runs when the function ends and cannot
  wait. Not in markup: its code runs again on updates. A component cannot be async: load the data
  in `mount()` or in an event handler.
- **An event handler may be async:** `onClick={async () => { user = await load() }}`. A change of
  state after `await` updates the markup like any other.
- A `defer` of an async function runs when it ends, after everything it has waited for.

A Promise made by hand gets its type from the declared one:

```go
async func sleep(ms number) {
    const done Promise<number> = new Promise(resolve => setTimeout(() => resolve(ms), ms))
    await done
}
```

### Goroutines

```go
func countPrimes(from, to number) number {
    // ...
}

const PART = 1_000_000
const parts = await Promise.all([0, 1, 2, 3].map(i => go countPrimes(i * PART, (i + 1) * PART)))
go countPrimes(0, 100)              // nothing waits for it
```

```js
const parts = await Promise.all([0, 1, 2, 3].map((i) => $$go("countPrimes", [i * PART, (i + 1) * PART])));
$$go("countPrimes", [0, 100]);
```

`go f(x)` calls `f` as a goroutine, in another thread, and the program goes on without waiting for
it. Goroutines run at once, on different processors: the threads are a pool of workers, Web
Workers in the browser and worker threads in Node, and a worker can run several goroutines (see
"The pool" below).

- **What `go` calls:** a function declared at the top level of the module, an imported one, or a
  function literal, `go func(n number) { ... }(i)`. A goroutine shares no memory with the program:
  its worker loads the functions that `go` calls, with the declarations and the imports that their
  code uses, but not the rest of the module and not its top-level code. The modules it imports run
  their top-level code in the worker too.
- **A function literal** gets copies of the local names it uses, as it gets its arguments, when
  `go` runs: so they must be data, and the literal cannot assign them, since that would change only
  its copy. It compiles to a function of the worker module, `$$goroutine0`, whose first parameters
  are these names.
- **Copies:** the goroutine gets copies of the arguments, and the program gets a copy of the result
  (the structured clone of `postMessage`). So they are data: numbers, strings, `bool`, arrays,
  objects of interfaces without methods, `Map`, `Set`, `Date`, typed arrays, `error`. A function,
  an instance of a class or a DOM element is a compile error: its copy would lose its methods.
  Changing a copy does not change the original.
- **Moving instead of copying:** `transfer(x)` gives `x`, an `ArrayBuffer` or a typed array, and
  marks its buffer: the next time it goes to another thread, as an argument, a result or through a
  channel, it moves there without a copy, and here it is left empty (the transfer list of
  `postMessage`). `go sum(transfer(data))` passes a large array for free; `data.length` is 0 after
  it.
- **No shared state:** the code of the function cannot use the `let` variables of the module, since
  each worker would have its own, nor components and markup, since a worker has no document. Values
  go in as arguments and come back as the result.
- **The result:** as an expression, `go f(x)` is a Promise of what `f` returns, or of what its
  Promise gives for an async `f`: `const n, err = await go load(id)`. As a statement nothing waits
  for it, and an exception in it is not caught: in Node it ends the program, like a panic in Go.
- **The pool:** the workers start on the first `go`, up to one per processor, and the modules of
  the program share them. A call waits in one queue for a free worker of its module, one whose
  thread is not running code: a worker that is busy with a long call gets no more, and the next
  call goes to the first worker that is free. A worker runs several calls at once while they wait
  in `await`, so a call goes to a free worker without calls, else to a new worker, else to a free
  worker whose calls wait. When there are as many workers as processors, an idle worker of another
  module makes room, unless it keeps channels. In Node, idle workers do not keep the program
  running, but, unlike Go, the program waits for the goroutines that run, even for one that waits
  forever to send to a channel nobody reads, and for a worker whose channel it waits for. `go`
  inside a goroutine runs in the same worker.

The worker module goes next to the module: `mango build app.mango` writes `app.js` and
`app.worker.js`, `mango run` compiles it on the fly, and the Vite plugin gives it to Vite, which
bundles it as a worker.

`go` is for work that keeps a processor busy. Waiting, for a timer or the network, needs no
thread: the call of an async function without `await`, `search(query, out)`, runs in the same
thread at once with the rest of the program, sharing its memory, as goroutines of Go share theirs.
It talks to the others through channels as well.

### Channels

```go
async func square(jobs chan number, results chan number) {
    for n in jobs {
        results <- n * n
    }
}

const jobs = chan<number>(10)          // room for 10 values
const results = chan<number>()          // no room: a send waits for a receiver
go square(jobs, results)
go square(jobs, results)
for let n = 1; n <= 4; n++ {
    jobs <- n
}
close(jobs)
for let i = 0; i < 4; i++ {
    console.log(<-results)
}
```

```js
const jobs = $$chan(10, 0);
const results = $$chan(0, 0);
// ...
await $$send(jobs, n);
// ...
console.log(await $$receive(results));
```

Channels pass values between goroutines, as in Go. `chan T` is the type of a channel of `T`, and
`chan<T>(size)` makes one with room for `size` values; `chan<T>()` has none.

- **`ch <- v` sends a value** and waits until the channel takes it: while the channel has room,
  at once, and otherwise until a receiver comes. **`<-ch` receives a value**, waiting until there
  is one. Both wait, so they are allowed where `await` is, in async functions and at the top
  level of a module, and compile to `await`.
- **`for v in ch`** receives values until the channel is closed and empty.
- **`close(ch)`** closes the channel: nothing more goes in, and a send to a closed channel or a
  second `close` throws. A closed, empty channel gives the zero value of its type at once, as in
  Go, and `const v, ok = <-ch` tells it: `ok` is `false`. A type without a zero value (an
  interface, a class) gives `null`, so `<-ch` of a `chan Point` is a `?Point`.
- **Between threads:** a channel goes to another thread as its id, so goroutines in different
  workers and the main thread share it, and what goes through it between threads is copied. So
  `go` checks that the values of a channel can be copied, as it does for arguments. Within one
  thread a value is passed itself. What a channel holds lives in the thread that made it, and the
  other threads ask that thread directly, each through a port of its own: workers pass values to
  each other also while the main thread is busy. A channel that goes on with a case of a `select`
  over channels of several threads locks the `select` first, so only one case goes on, as in Go.
  A channel that no value holds any more, in any thread, is forgotten.
- `chan number` is not a `chan ?number`: a channel both takes and gives values, so the types must
  be the same.
- **One direction:** `chan<- T` only sends and `<-chan T` only receives, as in Go: a function that
  takes `out chan<- string` can only send to it, and `close` it. A `chan T` goes where either is
  expected, but not the other way round. `<-` goes with the leftmost `chan`, so `chan<- chan T` is
  a channel that sends channels, and a channel of `<-chan T` is written `chan (<-chan T)`.

### select

```go
select {
case job = <-jobs:
    work(job)
case msg, ok = <-control:
    if !ok {
        return
    }
case results <- last:
    console.log("sent")
case <-quit:
    return
default:
    console.log("nothing is ready")
}
```

```js
{
  const [$$case, $$received, $$ok] = await $$select([{ channel: jobs }, { channel: control }, { channel: results, value: last }, { channel: quit }], true);
  switch ($$case) {
    case 0: {
      const job = $$received;
      work(job);
      break;
    }
    // ...
  }
}
```

`select` waits until one of several operations on channels can go on, does it and runs its case,
as in Go. A case receives, `case v = <-ch:` or `case <-ch:`, or sends, `case ch <- v:`.

- **The variables of a case:** `case job = <-jobs:` declares `job` for that case only, and
  `case msg, ok = <-control:` gets `ok` as `v, ok = <-ch` does. They are always new variables: to
  keep the value, assign it in the case.
- **Which case:** one that can go on at once, a random one if several can; otherwise `default`, if
  there is one; otherwise `select` waits for the first one that can.
- **A null channel** turns its case off, as a nil channel does in Go: the channel of a case may be
  a `?chan T`, and a case whose channel is `null` never goes on. So a loop can stop waiting on a
  channel by setting a variable to `null`.
- `break` inside a case leaves the `select`, as in Go.
- `select` waits, so it is allowed where `await` is. It is a keyword only before `{`: elsewhere
  `select` is an ordinary name.

### Timers and cancel

```go
const ticks = tick(100)
const done = chan<number>(1)
const task = go async func() {
    done <- countPrimes(100_000_000)
}()

select {
case n = <-done:
    console.log(n)
case <-after(500):
    cancel(task)
}
close(ticks)
```

```js
const ticks = $$tick(100);
// ...
const [$$case, $$received, $$ok] = await $$select([{ channel: done }, { channel: $$after(500) }], false);
// ...
$$cancel(task);
```

- **`after(ms)`** is a `<-chan number` that gets the time (`Date.now()`) once, after `ms`, as
  `time.After` in Go: `case <-after(500):` is a timeout.
- **`tick(ms)`** is a `chan number` that gets the time every `ms`, as `time.Tick`. A tick that
  finds the last one not received yet is dropped. `close(ticks)` stops it; until then, in Node, it
  keeps the program running.
- **`cancel(task)`** stops a goroutine, given the Promise of `go`: a call that waits for a worker
  leaves the queue, and a running one stops with its worker (`terminate()`), even in the middle of
  a loop. Its Promise fails with "goroutine cancelled", and nothing else fails because of it if
  nobody waits for it. The other calls that wait in that worker in `await` fail too, and the
  channels that the worker made are gone. Inside a goroutine, `go` runs in the same worker, so
  `cancel` makes its Promise fail, but code that has started goes on. A Promise that is not of
  `go`, or of one that has finished, is left as it is.
- `after`, `tick` and `cancel` are predeclared, like `close`: a declaration with one of these names
  hides them.

## 6. Conditions and loops

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

| MangoScript                      | JS                                          |
| -------------------------------- | ------------------------------------------- |
| `for let i = 0; i < n; i++ { }`  | `for (let i = 0; i < n; i++) { }`           |
| `for x in items { }`             | `for (const x of items) { }`                |
| `for i, x in items { }`          | `for (const [i, x] of items.entries()) { }` |
| `for v in scores { }` (a Map)    | `for (const v of scores.values()) { }`      |
| `for v in seq { }` (an iterator) | `for (const v of seq()) { }`                |
| `for cond { }`                   | `while (cond) { }`                          |
| `for { }`                        | `while (true) { }`                          |

`for x in items` goes over the **values**, like `for...of` in JS or `for x in` in Python and Rust,
not over the keys like `for...in` in JS. In Go, `for i := range xs` with one variable gives the
index; here one variable gets the value, and two get the index and the value.

- **Besides arrays and strings,** `for` goes over what the lib files make iterable (with
  `[Symbol.iterator]()`): a `Set`, a typed array, a `NodeList`, an iterator. Two variables need
  positions or keys: a typed array and a `NodeList` give the index and the value, as an array does;
  a `Set` has no keys.
- **A Map** gives its keys and values, as a map in Go: `for name, score in scores`. One variable
  gets the values, as with an array, and compiles to `scores.values()`. A value whose type is not
  known (`any`) is tested at runtime, so that a Map gives its values there too; code built with
  `--no-check` loops with `for...of` as it is.
- **A typed array** is indexed as an array is: `data[i]` reads and writes a number, and it can go
  where an `ArrayLike<number>` is expected, as in `Array.from(data)`.

`break` and `continue` work as usual.

### Iterators

```go
func count(n number) func(yield func(number) bool) {
    return func(yield func(number) bool) {
        defer console.log("done")
        for let i = 0; i < n; i++ {
            if !yield(i) {
                return
            }
        }
    }
}

for i in count(10) {
    if i == 3 {
        break
    }
}
const firstThree = count(1_000_000)().take(3).toArray()
```

```js
function count(n) {
  return function* () {
    try {
      for (let i = 0; i < n; i++) {
        yield i;
      }
    } finally {
      console.log("done");
    }
  };
}

for (const i of count(10)()) {
  if (i === 3) {
    break;
  }
}
const firstThree = count(1_000_000)().take(3).toArray();
```

An iterator is a function whose one parameter is named `yield`, as in Go 1.23:
`func(yield func(T) bool)` gives values of `T`, and `func(yield func(K, V) bool)` gives pairs. It
calls `yield(v)` for each value; `for v in seq` goes over them and `for k, v in seq` over the pairs,
where one variable gets the second of a pair, as with a Map.

- **The name makes the type:** `func(yield func(T) bool)` is an iterator, and `func(func(T) bool)`
  a function that takes a callback; neither goes where the other is expected. A function type may
  name its parameters, as in Go.
- **It compiles to a JS generator** (`function*`): `yield(v)` becomes `yield v`, and
  `yield(k, v)` becomes `yield [k, v]`. `if !yield(v) { return }`, the way an iterator of Go stops,
  becomes `yield v`: when the loop stops, with `break`, `return` or an exception, JS closes the
  generator where it yields, so the iterator returns there and its `defer`s run. For the same
  reason a `yield(v)` used as a value is always `true`.
- **A lazy JS iterator:** `seq()`, a call without arguments, gives the generator, with the helpers
  of iterators: `seq().filter(f).take(5).toArray()`. JS code goes over it with
  `for (const v of seq())`, and declarations for TypeScript give it as `() => Generator<T>`.
  Calling an iterator with a function, as Go allows, is an error.
- **What a generator cannot do:** `yield` is called only in the body of the iterator itself, not
  in a function inside it (`items.forEach(x => yield(x))` is an error: loop with `for` there), and
  it is not passed on or kept. An iterator is written with `func`: a declaration, a literal or a
  method, not an arrow function. It is not async, and it returns nothing.
- `for` over an iterator whose type is not known (`any`) calls it at runtime.

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

## 7. Errors

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

## 8. Classes

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

## 9. Interfaces

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

## 10. Modules

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
| `Box<T>`, `function first<T>(...)`              | generics: `Box<T>`, inferred type arguments  |
| overloads                                       | a call picks the first signature that fits   |
| `enum`                                          | a union of literals                          |
| `[key: string]: T`                              | unknown members have the type `T`            |
| `bigint`; `Uint8Array`                          | `bigint`; `[]byte`, the same type            |
| `unknown`, `object`, `symbol`                   | `any`                                        |
| conditional and mapped types TS did not reduce  | `any`                                        |

- `import x from "pkg"` is the default export; for modules with `export =` it is the value itself,
  and named imports are its properties: `import { join } from "node:path"`.
- A type parameter with a default may be left out: `Buffer` is `Buffer<ArrayBufferLike>`. Such a
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

export class Stack<T> {
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
  them. Components do not exist in JS, nor in the declarations; a value of type `comp(title string)`
  is the function of a component, `(title: string) => [Node, ...unknown[]]`.
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
- **SVG:** `<svg>`, the elements inside it and the tags that only SVG has (`<path>`, `<circle>`,
  `<g>`...) are created in the SVG namespace, with `createElementNS`, and their attributes are set
  with `setAttribute`. `<a>`, `<title>` and the other tags HTML has too are SVG only inside `<svg>`;
  the children of `<foreignObject>` are HTML.
- **Many elements:** a module whose code creates more than 20 elements creates them with a helper
  that takes the attributes they have from the start,
  `$$element("a", { href: "/", className: "nav" }, { "aria-label": label })`, instead of
  `createElement` and a statement per attribute. Handlers, `bind:`, styles, attributes that may be
  `null` and those after a spread stay statements.
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
- **`...attrs`,** the last property, takes the attributes of a use that are not properties;
  `{...attrs}` puts them on one element of the component's markup, created once, and the use is
  checked as if they were written on that element. A class or a style is added to the element's.
- **There is no component in JS:** its code is inlined as a block where it is used, and the values
  of the attributes are computed before that block. The exceptions are recursive and exported
  components and components used as values, see below, and large ones: a component whose copies
  would add more than 100 lines compared to a function and its calls is compiled to a function.
- **Recursive components** (a tree, nested comments) are not inlined but compiled to a function.
  Some use on the cycle must be under a condition (`if`, `for`, a branch of `?:`), or the recursion
  never ends: that is a compile error.
- **Exported components** (`export comp Card`) are imported by name,
  `import { Card } from "./card.mango"`, and used as tags. Their module compiles them to functions,
  `export function $$Card(...)`. The module that uses one calls it, or inlines it by the same
  100-line threshold, with the components of its module that it uses; the names of that module
  come through hidden exports, `export { PREFIX as $$Card$PREFIX }`. A component that assigns a
  variable of its module is always called, since another module can only read it.
- **Components as values.** `content: Intro` is a value of type `comp()`, and
  `comp(title string, kind ?Kind)` lists the properties with their names. A tag takes the
  component from a value: `<section.content />`, or `<Page />` with a variable `Page`. It passes
  the properties in the order of the type, so a component fits a type with the same names in the
  same order; it may have more at the end if they may be left out, and a property with a default
  value fits `?T`. Such a component is a function, `$$Intro`, and the tag calls it. When the value
  depends on state and changes, the component is created again; `ref` and spread are not possible
  on such a tag.

  ```go
  interface Section {
      title string
      content comp()
  }

  const SECTIONS []Section = [{ title: "Introduction", content: Intro }]

  comp Guide() {
      return <main>{for section in SECTIONS { <section.content /> }}</main>
  }
  ```

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

**Derived values.** `derived double = count * 2` at the top level of a component's body is a value
computed from state and properties. It is read like a constant, and assigning it is an error. When
what it reads changes, it is computed again, before the markup that reads it is updated:

```go
comp Counter(initialValue number) {
    state count = initialValue
    derived double = count * 2
    return <button onClick={count++}>{count} × 2 = {double}</button>
}
```

```js
let count = initialValue;
let double = count * 2;
// ...creating the nodes...
function $$updateCount2() {
  double = count * 2;
  $$text5.data = count;
  $$text6.data = double;
}
```

- It is one name and one expression; its type may be written: `derived left number = ...`. It is
  declared only in a component (or a decorator), like `state`.
- It is computed again also when the body of the component changes the state before the markup
  exists, so it is right wherever it is read. One that reads no state and no properties that get
  the parent's state is a constant.

**Effects.** `effect { ... }` at the top level of a component's body runs once the markup is
created, and again after the updates whenever what it reads changes. What it reads is what its code
reads while it runs: not in the functions it creates (`setInterval(() => ...)`) or in its
`defer`, and not the variables it writes. It cleans up with `defer`: the deferred call runs before
the effect runs again, and when `{if}`, `{switch}` or `{for}` removes the component.

```go
comp Todos() {
    state todos []string = load()
    // Saved again on every change of the list.
    effect {
        localStorage.setItem("todos", JSON.stringify(todos))
    }
    // ...
}
```

- An effect returns nothing. Unlike `mount()`, it does not wait for the markup to be in the
  document, and it runs again.
- An effect after an early `return` of the component may not be created, so, like the markup
  there, it does not run again on changes.

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

**References.** `ref name` at the top level of the body of a component or a decorator names an
element of its markup, which `ref={name}` gives:

```go
comp Search() {
    ref input
    mount() {
        input.focus()
    }
    return <form class="search">
        <label for={input.id}>Find</label>
        <input id="query" ref={input} />
    </form>
}
```

```js
const input = document.createElement("input");
input.id = "query";
$$mount(() => $$mountNode2, () => {
  input.focus();
});
// ...the markup fills the element in instead of creating it:
$$label3.htmlFor = input.id;
```

- **The element exists from the start.** It is created where the ref is declared, with its
  constant attributes: those written as a string or without a value, before any `{...spread}`.
  The markup sets the rest where it is written: values in `{...}`, handlers, `bind:` and children.
  So a ref is never `null`, and markup can refer to an element written further down.
- **The type** is that of the element (`HTMLInputElement`), or the one written:
  `ref input HTMLElement`. A ref cannot be assigned, and it is not state.
- **Once.** A ref is bound to one element, in markup created exactly once: what a `return` gives,
  `const x = <...>` at the top level of the body, the children of components there, and the wrapper
  of a decorator, for the refs of the decorator. Inside `{if}`, `{for}`, `{switch}`, expressions and
  functions a ref is an error. If an early `return` gives other markup, the element stays as it was
  declared, outside the document.
- **A ref to a component,** `<Card ref={card} />`, points to the element at the top of what `Card`
  creates, through the wrappers of its decorators. The ref creates that element, and `Card` fills
  it in: an inlined one directly, a function through its last argument, `$$root`. A component with
  several `return`s, one that returns a fragment, or a wrapper that returns some other expression
  cannot be pointed to: the element is not known in advance. A component cannot have a property
  named `ref`.

**Styles.** `style { ... }` at the top level of the body of a component or a decorator is CSS for
its own markup:

```go
comp Badge(color string) {
    style {
        .badge { padding: 2px 8px; background: {color}; }
    }
    return <span class="badge">new</span>
}
```

- **Scope.** The elements of the component's own markup get the class `mango-badge-<hash>`, and so
  does every compound selector, so the rules reach neither the rest of the page nor the markup of
  `children` and other components. `:global(...)` keeps a selector as it is.
- **Values from code.** `{expr}` in the value of a declaration (`name:` followed by a space or a
  value) is a string or a number. The value becomes a CSS variable that the compiler sets on the
  element the component returns, and again when what it reads changes.
- **The CSS** is added to `<head>` once by the code of the module, with `$$style`. A selector that
  matches no element of the markup is a warning, which does not stop compilation.

**CSS modules.** `import styles from "./button.module.css"` reads the file at compile time. Its
classes get names of their own, `button_14zwdg2`, and `styles` is an object of them: its type has a
`string` field for each class, so `styles.buton` is a compile error, and `styles[kind]` with
`kind "primary" | "ghost"` is checked too. Tags, `:root` and `:global(...)` stay global. The
import becomes the object, and the module adds the CSS to the page with `$$style`; the file is
not imported at runtime, so this works with `mango build` and with Vite. A class that the module
never names is a warning, unless it reads `styles` with a key that is not known.

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

**Decorators.** `dec name(parameters) { ... }` declares logic that is added to the components it
is applied to: state, functions, `mount()` and a wrapper around what the component returns. A
decorator is applied with `@name(arguments)`
before `comp`; like a component, it exists only at compile time, and its code is inlined into each
component.

```go
dec counter(start number = 0) {
    public state count = start
    let clicks = 0

    public func add() {
        count++
        clicks++
    }

    mount() {
        console.log("counting from", start)
    }
}

@counter(5)
comp Clicker(label string) {
    return <button onClick={@counter.add()}>{label}: {get(@counter.count)}</button>
}
```

- **Parameters** are written as for functions, but may have default values at the end. The
  arguments are positional; without arguments the parentheses can be left out: `@counter`. They
  are evaluated for every instance with the component's properties in scope, so
  `@counter(label.length)` works; when a property changes, the argument is computed again. In the
  decorator its parameters are read-only.
- **The body** may hold `state`, `const`, `let`, `ref`, `style`, functions, `mount()` and, at the end, the
  `return` of a wrapper; its refs are bound in the markup of the wrapper. Its own names are used in
  it as usual; the component does not see them unless they are `public`.
- **Public members** are `public state`, `public derived`, `public const` and `public func`;
  there is no `public let`. The component reads state, derived values and constants with
  `get(@counter.count)` (in markup this
  updates like its own state) and calls functions as `@counter.add()`. Outside the decorator its
  members are read-only: `get(@counter.count) = 0` or `get(@counter.items).push(x)` is an error,
  changes go through its public functions. `get` is special only when its argument starts with `@`.
- **The decorator does not see the component**, only its arguments, so it fits any component.
- **The wrapper** `return (content Element) => ...` gets what the component returned, and what it
  returns is what the component gives in the end. It is a function literal with one parameter, whose
  type is written: it limits where the decorator can be applied (`(form HTMLFormElement) => ...`
  only fits components that return a form), and the type of `<Clicker />` is what the outermost
  wrapper returns. The wrapper is called once, when the component is created; to change what is
  shown later, its markup reads the decorator's state, and it updates like the component's own. A
  wrapper returns once, at the end of its body.
- **Dependencies.** A decorator sees the public members of another one only if it names it after
  its parameters: `dec cartBadge() needs cart, auth { ... }`. Its body may read their state right
  away, so they must be applied above it: `@cart @cartBadge comp ...`. Decorators that need each
  other are an error.
- **Several decorators**, `@a @b comp X`: the bodies run from top to bottom, then the body of the
  component; the wrappers apply from the bottom up (the result of the component goes to `b`, the
  result of `b` to `a`); `mount()` runs from the inside out (the component, `b`, `a`), the
  cleanup in the reverse order. A decorator applied twice is an error, and `@html-tag` must be the
  first one.
- **The names of the module** that a decorator and its arguments use must not be declared in the
  component: its code runs inside the component.
- `dec` is a keyword only at the start of a declaration at the top level of a module.
- **Modules.** `export dec` exports a decorator; another module imports it by its name,
  `import { counter } from "./counter.mango"`, and applies it as usual. Its code is inlined there,
  and the names of its own module that it uses come through hidden exports:
  `export { log as $$counter$log }` in its module, `import { $$counter$log } from "./counter.js"`
  where it is applied. So an exported decorator cannot assign the variables of its module (other
  modules can only read them), and the decorators it needs are exported too. The components of
  its module that its code uses go with it, like those of an inlined component of another module;
  they cannot use components or decorators that their module imports yet.
- Not yet: renaming a decorator on import, `return` inside the `if` or `for` of a wrapper, and
  combining decorators.

```go
dec notFound() {
    state missing = false

    public func show() {
        missing = true
    }

    return (page Element) => <div class="page">{missing ? <NotFoundPage /> : page}</div>
}
```

In JS the decorator's code goes into the component's block, with its names prefixed. A wrapper is
inlined where the component returns: its markup is created first, in the variable of the
parameter (`$$notFound$page`), then the wrapper's markup around it.

```js
const $$counter$start = 5;
let $$counter$count = $$counter$start;
let $$counter$clicks = 0;
function $$counter$add() {
  $$counter$count++;
  $$updateCounter$count2();
  $$counter$clicks++;
}
```

The full design, reactivity included, is in [docs/components.md](components.md).

## 11. Operators: differences from JS

| MangoScript       | JS          | Note                                                      |
| ----------------- | ----------- | --------------------------------------------------------- |
| `a == b`          | `a === b`   | the language has no loose comparison                      |
| `a != b`          | `a !== b`   |                                                           |
| `x == null`       | `x == null` | stays loose: catches both `null` and `undefined`          |
| `a = b`, `a += b` | the same    | only as a statement: `f(a = 1)`, `a = b = c` are errors   |
| `i++`, `i--`      | the same    | only as a statement: `a = i++` is an error; no `++i`      |
| `&&`, `\|\|`, `!` | the same    | only for `bool`; a default value is written with `??`     |
| `a + b`           | the same    | numbers or strings; `"a" + 1` is an error, use a template |
| `x as T`          | `x`         | the types must be related, see below                      |
| `delete obj.key`  | the same    | only as a statement, see below                            |

The rest is as in JS: arithmetic, comparisons, bitwise operations, `**`, `??`, `?.`, `? :`,
`typeof`, `instanceof`, `new`, spread `...`, indexing `xs[i]`.

The language has no `var`, `function`, `===`, `while`, `do...while`, `for...in`, `with` or comma
operator.

- **`value as Type`** sees a value as another type, as in TypeScript, and leaves nothing in JS. The
  types must be related, one assignable to the other: `element as HTMLInputElement` and
  `JSON.parse(text) as Config` pass, `count as string` is an error. `as` binds like a comparison:
  `a + b as number > c` is `((a + b) as number) > c`. A variable named `as` is still a name.
- **`delete obj.key`** removes a key of a map (`{ [string]: T }`), a field of type `?T`, or a field
  of an `any`; a required field cannot be deleted, and an array needs `splice`. It is a statement,
  also in handlers, and in a component it updates what reads the object. `delete` is a keyword only
  at the start of a statement.

Only a function call or `new` can be a statement on its own, as in Go: a line `a + b` or
`user.name` by itself is an error. This catches typos and a line break before a binary operator:

```go
const total = price
    + tax              // error: there is already a ; after price, and "+ tax" does nothing
```

## 12. Type checking

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
  `let m Map<string, number>` is a `Map<string, number>`, and `m.get(k)` is a `?number`;
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
types of other imports come from TypeScript declarations (section 10).

## 13. Example

[examples/hello.mango](../examples/hello.mango)

## 14. Not in v0

- **`map[K]V`**, compiled to `Map`: `m[k]` → `m.get(k)`, `m[k] = v` → `m.set(k, v)`.
- **Classes:** getters and setters, `readonly`, abstract classes, constructor parameter properties
  (`constructor(private name string)`).
- **`if` with an initializer:** `if const v, err = f(); err != null { }`.
- **Labels** for `break`/`continue`.
- **Regular expression literals** `/.../g`. For now, `new RegExp("...", "g")`.
- **Source maps.**
- **A WASM backend** for a subset of the language (numbers, arrays, classes).

Planned next, around goroutines and what the browser has:

- **A parallel loop over an array,** for example `go for i, v in pixels { ... }`: the array is
  split into parts, one per processor, each part runs as a goroutine, and the loop waits for all of
  them, as a `WaitGroup` would. On a page with cross-origin isolation the parts write into a shared
  `SharedArrayBuffer`, without copies; elsewhere they are moved to the workers with `transfer` and
  back. GitHub Pages cannot send the COOP and COEP headers, so the site needs the second way.
- **`topic T`, channels between the tabs of a site,** over `BroadcastChannel`, for example
  `const cart = topic<CartEvent>("cart")`. It is a type of its own, not a `chan`: every tab that
  listens gets each value, and sending waits for nobody, so the promises of `chan` would not hold.
- **Streams and channels:** a channel that receives the chunks of a `ReadableStream`, such as the
  body of a `fetch` response, and a stream that reads a channel, so that goroutines make pipelines
  over the network. The room of the channel is the backpressure of the stream.
- **A ring buffer for the values of a channel:** now they are an array, and taking one out with
  `shift()` costs as many steps as the channel holds, which shows with `chan<number>(100_000)`.
- **State that survives a reload,** see Stages in [components.md](components.md).

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

## Known problems

1. **Types of TypeScript that extend `Array` cannot be indexed:** `match[1]` of a
   `RegExpExecArray` is an error, `cannot index RegExpExecArray`. For now, put the value into an
   `any` variable first. To be fixed.

## Implementation order

1. ~~A lexer that inserts `;` automatically.~~
2. ~~A parser → AST.~~
3. ~~JS generation.~~
4. ~~Type checking.~~
5. The features from "Not in v0".
