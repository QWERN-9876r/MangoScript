# Elements and components — design

**English** · [Русский](components.ru.md)

> Status: implemented are elements, components, `state`, `bind:`, `if` / `for` / `switch` in markup
> (stages 1–4), recursive components, early returns, `mount()`, web components (`@html-tag`),
> decorators (`dec`), `derived`, `effect`, `ref` and `style`. The decisions made are collected at the end of
> the document, together with what is not decided yet.

## Goals

1. **An element in code is a real DOM node.** `<a href="/">…</a>` is an expression that creates an
   `HTMLAnchorElement`. There is no virtual DOM.
2. **Components exist only at compile time.** JS has no objects, classes or functions of components
   and no runtime framework: only code that creates nodes and updates them. A component is a
   zero-cost abstraction.
3. **The compiler works out reactivity.** It sees which nodes depend on which state and, when the
   state changes, updates exactly those. Runtime mechanisms (proxies, function components) appear
   only where there is no way around them.
4. **Everything is type checked:** attributes, children, component properties, event handlers.

## Part 1. Elements

### Syntax

```go
const name = "to the home page"
const link = <a href="/" class="nav">Link {name}</a>     // HTMLAnchorElement
```

The syntax is that of JSX:

- attributes: a string `href="/"`, an expression `href={url}`, no value `disabled`, a spread
  `{...attrs}`;
- children: text, expressions in `{...}`, nested elements;
- `<input />` is a self-closing tag, `<>...</>` a fragment (`DocumentFragment`);
- `{/* comment */}` inside markup.

Attribute names are those of HTML, not the DOM properties of JSX: `class`, not `className`, `for`,
not `htmlFor`. Markup has no conflict with keywords, so there is no reason to rename them.

Elements are ordinary values: they can be put into a variable, returned from a function, passed to
`append`. Outside components that is all a reference to an element needs:

```go
const input = <input placeholder="Name" />
input.focus()
form.append(input)
```

In a component that would take the element out of the markup it returns. There `ref input` names an
element without taking it out, see "References: `ref`".

### Types

| Literal                | Type                                         |
| ---------------------- | -------------------------------------------- |
| `<a>`, `<input>`, ...  | `HTMLAnchorElement`, `HTMLInputElement`, ... |
| an unknown tag         | `HTMLElement`                                |
| `<>...</>`             | `DocumentFragment`                           |
| `<svg>`, `<path>`, ... | `SVGSVGElement`, `SVGPathElement`, ...       |

This needed the DOM among the built-in types: `Node`, `HTMLElement` and the most common elements,
`Event` and its variants, the type of `document`. Done: in Node the DOM types come from TypeScript's
`lib.dom`, and the browser compiler has hand-written ones.

SVG works without anything extra: `<svg>`, the elements inside it and the tags that only SVG has
(`<path>`, `<circle>`, `<g>`...) are created with `createElementNS`, and their attributes with
`setAttribute`, since SVG properties are objects, not strings. Tags HTML has too (`<a>`,
`<title>`) are SVG only inside `<svg>`, and the children of `<foreignObject>` are HTML again. So a
component can return `<path>` to be put into an icon.

What can be passed as a child in `{...}`:

- `string` or `number` becomes text;
- a `Node` is inserted as it is;
- a `[]T` of such values is inserted item by item;
- a `?T`: `null` shows nothing.

`bool` is an error: in MangoScript `&&` works only with `bool` anyway, so the JSX idiom
`{ok && <b/>}` is impossible. Instead, `{ok ? <b /> : null}` or `{if ok { <b /> }}` (see below).

### Attributes and properties

The compiler knows the DOM and chooses how to set a value:

- **A property** if the element has one: `value`, `checked`, `disabled`, `hidden`, `href`, `id`…
  `class` → `className`, `for` → `htmlFor`.
- **`setAttribute`** for the rest, `data-*` and `aria-*` included.
- **`style`:** a string sets `style.cssText`, an object sets one property at a time.
- **`on*`** is an event handler, **`bind:*`** a two-way binding, see below.

The value of an attribute is a `string`, `number`, `bool` or `?T` (`null` means no attribute). For
known properties the type is checked more precisely: `checked={1}` is an error.

### Event handlers

```go
<button onClick={count++}>+1</button>                         // code that runs on a click
<button onClick={save(todo)}>Save</button>
<form onSubmit={event.preventDefault(); send()}>...</form>    // several statements with ;
<button onClick={handleClick}>...</button>                     // a ready function
<button onClick={() => handleClick(1)}>...</button>
```

The rule (as in Vue):

- **A name, a path `obj.method` or a function literal** is the handler itself.
- **Anything else** is statements that run on the event. The variable `event` is available inside.

Unlike JSX, `onClick={save(todo)}` calls `save` on a click, not when the element is created. The
classic JSX mistake is simply impossible here. The rule fits the language well: `count++` and
assignment are statements in MangoScript anyway, not expressions.

`event` is typed by the event (`onInput` → `InputEvent`), and `event.currentTarget` has the type of
the element itself. So `onInput={title = event.currentTarget.value}` passes type checking without
casts.

A handler runs on the event, after its element is created, so it can use the variable the element
is assigned to (see "A variable in its own initializer" in the specification):

```go
const close = <button onClick={close.remove()}>×</button>
```

An attribute like `title={close.title}` is read right away, so there it is an error.

### How it compiles

Elements outside components are static: the values in `{...}` are computed once.

```go
const link = <a href="/" class="nav">Link {name}</a>
```

```js
const link = document.createElement("a");
link.href = "/";
link.className = "nav";
link.append("Link ", name);
```

If an element is inside an expression, the code that creates it is moved before the statement into
temporaries. The element (and the expressions inside it) is created before the rest of the
statement. In MangoScript only calls have side effects in expressions, so this is noticeable only if
the calls of one statement depend on each other. Inside the markup itself the order is kept.

```go
document.body.append(<p>Hello</p>)
```

```js
const $$p1 = document.createElement("p");
$$p1.append("Hello");
document.body.append($$p1);
```

Code cannot be moved where an expression is not evaluated exactly once: in the branches of `? :`, on
the right of `??`, `&&` and `||`, after `?.`, in the conditions of `else if` and loops, in the values
of `case` and in class fields. There the creation of the element is wrapped in an arrow function
that is called at once. An arrow function with markup in its body (`items.map(i => <li>{i}</li>)`)
gets a block body.

Even without components this simplifies code a lot. For example, `renderItem` of the test site:

```go
func renderItem(todo Todo) HTMLLIElement {
    return <li class={todo.done ? "todo done" : "todo"}>
        <input type="checkbox" checked={todo.done} onChange={toggle(todo.id)} />
        <span>{todo.title}</span>
        <button title="Remove" onClick={remove(todo.id)}>×</button>
    </li>
}
```

Before, the same function took 25 lines of `createElement` and `addEventListener` calls.

### Lexical structure

- Spaces and line breaks in text follow the JSX rules. A line of only spaces disappears; spaces with
  a line break at the edges of text are trimmed.
- No automatic `;` is inserted inside markup. An element ends at the `>` of the closing tag or at
  `/>`; a line break after it inserts `;`, as after any value.
- As with the `{` of a block, the opening tag goes on the same line as `return`: `return <div>`.
  Otherwise `return` would end at the line break. `return (` with a line break works too.
- `<` at the start of an expression is unambiguous. The language has no generics in `<...>` and no
  casts `<T>x`, so `<` where a value is expected is always an element, and after a value it is a
  comparison. But the lexer must read the text inside markup by other rules. So the parser drives
  the lexer: it asks for the next token in the needed mode, as TypeScript does.

## Part 2. Components

### Declaration and use

```go
comp Counter(initialValue number) {
    state count = initialValue
    return <button onClick={count++}>Clicked {count} times</button>
}

document.body.append(<Counter initialValue={0} />)
```

- **Declaration.** `comp Name(parameters) { ... }`. The parameters are the component's properties,
  in Go syntax.
- **Use.** A component is used as a tag with a capital letter. Attributes are matched with the
  parameters by name and checked like the arguments of a function. Required parameters cannot be
  left out, and an extra attribute is an error (like an extra field in an object literal).
- **Optional properties** have default values:
  `comp Button(label string, kind string = "primary")`. Default values are allowed only for
  components: attributes are named, so defaults are natural here.
- **The body runs once,** when the component is created (as in Solid). It ends with a `return` of
  markup. Only the markup, `derived` and `effect` are reactive.
- **An early `return`** returns markup too, for example as the base case of recursion:
  `if depth > 3 { return <span>…</span> }`. The choice between the `return`s is made once, at
  creation; inside the chosen markup everything updates as usual. If the markup must change with
  the state, it is written with `{if ...}`. In JS an inlined component leaves its block with a
  labeled `break`, and a function component with `return`.
- **The type of `<Counter />`** is the type of the returned markup, here `HTMLButtonElement`; with
  early `return`s, the common type of all the returned elements. A use of a component is the same
  kind of element expression as `<button>`.

### State

| Construct                               | What it does                                                      |
| --------------------------------------- | ----------------------------------------------------------------- |
| `state count = 0`, `state items []Todo` | a reactive variable, like `let`; without a value, the zero value  |
| `derived double = count * 2`            | a computed value, read-only, like `const`                         |
| `effect { ... }`                        | code that runs after creation and whenever what it reads changes  |
| `ref input`                             | an element of the markup, which exists from the start of the body |

The type can be written as with `let`: `state count number = 0`, `derived left number = ...`.

`state`, `derived`, `effect`, `ref` and `style` are keywords only at the start of a statement inside `comp`.
In other code they are ordinary names: `let state = load()` can still be written (the same way as
`static` and `private` in classes).

Changes are tracked by writes to the variable:

- assignment: `count = 0`, `count += 1`, `count++`;
- the mutating methods of arrays: `todos.push(x)`, `todos.splice(i, 1)`, `todos.sort()`…;
- methods of objects and classes: `list.add(x)`. The compiler does not check yet what a method does,
  so a call of any method counts as a change, except known reading ones (`map`, `filter`, `slice`,
  `toFixed`…);
- writes to fields inside the value: `todo.done = true` if `todo` came from `todos`: through
  `for todo in todos`, `todos.map(todo => ...)` or `const todo = todos[0]`.

The compiler knows every such place and every place where the value is read, so after a write it
inserts the update of exactly the nodes that depend on it. An extra update breaks nothing, and a
missed one leaves an old value on the page. So the analysis is cautious: a local variable named like
the state gives extra updates but loses no needed one.

`effect` has no separate API for cleaning up. `defer` does it: the deferred call runs before the
effect runs again and when the component is removed.

```go
comp Clock() {
    state now = new Date()
    effect {
        const timer = setInterval(() => { now = new Date() }, 1000)
        defer clearInterval(timer)
    }
    return <time>{now.toLocaleTimeString()}</time>
}
```

`mount()` is implemented already (decision 8): it runs once the markup is in the document, and the
function it returns runs when `{if}`, `{switch}` or `{for}` removes the markup.

### How it compiles

A component is inlined where it is used, like a macro. Constant properties are substituted:

```js
// <Counter>
let $$counter1;
{
  const initialValue = 0;
  let count = initialValue;
  const $$button3 = document.createElement("button");
  $$button3.addEventListener("click", () => {
    count++;
    $$text4.data = count;
  });
  const $$text4 = document.createTextNode(count);
  $$button3.append("Clicked ", $$text4, " times");
  $$counter1 = $$button3;
}
document.body.append($$counter1);
```

That is all the code: neither a `Counter` function nor a library. If the state has several
dependents or is changed in several places, the updates are collected in one function that is
called after every write:

```go
comp Counter(initialValue number) {
    state count = initialValue
    derived double = count * 2
    return <p>
        <button onClick={count++}>+1</button>
        {count} × 2 = {double}
    </p>
}
```

```js
let count = 0;
let double = count * 2;
// ...creating the nodes...
function $$updateCount2() {
  double = count * 2;
  $$text5.data = count;
  $$text6.data = double;
}
$$button4.addEventListener("click", () => {
  count++;
  $$updateCount2();
});
```

Two uses of `<Counter />` give two independent sets of variables: the code of each use is in its own
block `{ ... }`.

Inlining has three advantages:

- **No runtime.** No component function, no instance object, no subscription mechanism.
- **Constants fold.** `<Icon name="star" />` becomes only the code for the star, and the branches for
  other icons disappear.
- **Reactivity across components is static.** If the parent passes `count={count}` to a child, the
  child's code ends up in the same place. So the update of its nodes simply goes into the parent's
  `$$updateCount`, with no subscriptions between components.

A component from another module (`export comp`) is inlined the same way when it is small, and called
otherwise: its module compiles it to a function too, see "When a component becomes a function". The
choice is the 100-line threshold, as for the module's own components. A component is not meant to be
called from JS: the function is a detail of compilation.

### How updates work

This is how it was implemented in stage 3.

- **Live markup** is the markup the component creates once: returned from the body and the elements
  declared at the top level of the body (`const input = <input />`). Markup inside functions and
  expressions (`{items.map(i => <li>{i}</li>)}`) is created again on every evaluation, so it needs
  no updates in place.
- **Text** (`{count}` of type `string` or `number`) becomes a text node whose `data` changes. **An
  attribute** is updated by the same assignment that set it. **Nodes** (`{list}`,
  `{ok ? <b /> : null}`) are kept by the `$$content` helper: on an update it evaluates the expression
  again and replaces the nodes, and those that stay are moved, not created again.
- **An update function** for each `state` variable, with the updates of everything that reads it:
  directly, through the component's local functions or through variables that point into the state.
  If there is one place of writing and the update is one statement, it is written right at that
  place, as in `Counter` above. If nothing depends on the variable, there are no updates at all.
- **Functions of the component's body** (`func add() { todos.push(...) }`) call the update too. But
  they can also be called in the body itself, before there is markup. So such an update function
  first checks whether the component has been created: `if (!$$app1) return;`.
- **Rendering code calls no updates.** That is the expressions of live markup, the component's
  functions they call (`{summary()}`), and the callbacks they pass (`items.map(...)`). Otherwise an
  update that computes `summary()` would run itself. Event handlers and function properties inside
  markup run later, so their updates stay.
- **A property of a child component** whose value reads the parent's state becomes a variable in
  the child's block. The parent's update calls a function that changes it and updates the child's
  nodes:

  ```js
  let $$setValue5;
  {
    let value = count;
    // ...creating the nodes...
    $$setValue5 = ($$value) => {
      value = $$value;
      $$text9.data = value;
    };
  }
  function $$updateCount2() {
    $$setValue5(count);
  }
  ```

**Limitations of stage 3.**

- Changes inside functions the state was passed to (`sortInPlace(todos)`) are not seen. That is a
  task for stage 6; for now, after such a call, assign the variable to itself: `todos = todos`.
- A change of state while markup is being created (for example, a function property that a child
  component calls in its body) does not update the nodes already created.
- Nodes from an expression are created again as a whole: a list from `.map()` is recreated on any
  change, and the state of the components inside it is reset. Changing lists have `{for ...}`, see
  "Control flow in markup".

### When a component becomes a function

Inlining is not always possible. In three cases the compiler makes a function of a component:

1. **The component is recursive** (a tree, nested comments), directly or through other components.
   This is implemented, see below.
2. **Inlining adds more than 100 extra lines.** Extra lines are the total size of all the inlined
   copies minus the size of one function and its calls. A component used once is always inlined.
   Implemented: the module is generated again with each candidate as a function and the sizes are
   compared; the one that saves the most goes first, since that changes the sizes of the
   components inside it. Copies are counted in the generated code, so a small component with
   reactive properties used in many places can pass the threshold too.
3. **The component is exported** (`export comp`). Implemented: its module exports the function,
   `export function $$Card(...)`, which it calls itself. A module that imports `Card` either
   imports the function, `import { $$Card } from "./card.js"`, or inlines the component by the
   same threshold. For that, the module of `Card` exports the names its code uses under hidden
   names, `export { PREFIX as $$Card$PREFIX }`, and the module that inlines it renames them,
   `import { $$Card$PREFIX as $$Box$PREFIX }` for `import { Card as Box }`. The components of the
   other module that `Card` uses are inlined with it under tags of their own (`Box$Icon`), so the
   names of this module do not get in their way, and its decorators get prefixes of their own
   (`$$Box$visible$shown`). The components of the other module that are functions there are
   called. The function of an inlined component is in the other module, and the threshold counts
   it as one copy. A component that uses components or decorators that its module imports is
   always called: their code would need the names of a third module.

Such a function is a detail of compilation: its name is internal (`$$Tree`), and only an exported
component's is among the module's exports. It gets the properties as arguments and returns the
node and a function that sets the properties again:

```go
comp Tree(item Item, depth number = 0) {
    state open = depth == 0
    return <li>
        <button onClick={open = !open}>{open ? "−" : "+"}</button>
        {item.name}
        {if open {
            <ul>{for child in item.children { <Tree item={child} depth={depth + 1} /> }}</ul>
        }}
    </li>
}
```

```js
function $$Tree(item, depth = 0) {
  let $$tree4;
  let open = depth === 0;
  // ...creating the nodes, every call has its own state...
  const [$$for12, $$updateFor12] = $$list(() => item.children, (child) => {
    // ...
    const [$$tree14, $$setTree14] = $$Tree(child, $$0);
    return [$$block13, () => {
      $$setTree14(child, depth + 1);
    }];
  });
  // ...
  $$tree4 = $$li5;
  return [$$tree4, ($$item, $$depth = 0) => {
    item = $$item;
    depth = $$depth;
    $$text8.data = item.name;
    $$updateIf9();
  }];
}

// <Tree item={root} /> where it is used:
const [$$tree16] = $$Tree(root);
```

- **Every property except `children`** is a source of updates in the function: it is not known in
  advance which of them will get the caller's state.
- **The caller** passes the properties as arguments, without inlining, so names at the place of use
  get in the way of nothing. If the values of the properties depend on its state, its updates call
  the returned function with the new values.
- **The recursion must end.** If no use on the cycle is under a condition (inside `if`, `for`,
  `switch`, a branch of `?:` or a function), creating the component never ends, and that is a
  compile error: `endless recursion: Tree → Tree always creates itself again`.

There are still no subscriptions. The parent knows statically which properties depend on its state
and calls the function that sets them itself when that state changes. Only constant folding is
lost: there is one function for all the places of use.

### Changes the compiler cannot see: proxies

Static tracking works as long as all the changes of state are visible in the component's code.
Proxies appear only where they are not:

- **Primitives** (`number`, `string`, `bool`) never need proxies: they change only by assignment to
  the variable, and that is visible.
- **An array or an object** that does not leave the component (including going into inlined child
  components) is tracked statically.
- **If a value is passed to a MangoScript function,** the compiler checks whether it changes it:
  assignments through the parameter, `push` and the like, passing it further to changing functions.
  If it does not, no proxy is needed. For example, `save(todos)` in the example below only calls
  `JSON.stringify`.
- **If a value goes into code the compiler cannot see** (JS functions and everything of type `any`)
  or into a function that changes it, the state is wrapped in a proxy. The proxy calls the update
  after any change, nested objects included (it wraps them when they are read).

```go
import confetti from "canvas-confetti"          // a JS library: the compiler does not know what it does

comp Party() {
    state options = { particleCount: 100, spread: 70 }
    return <button onClick={confetti(options)}>Hooray!</button>
}
```

```js
let options = $$reactive({ particleCount: 100, spread: 70 }, $$updateOptions);
```

`$$reactive` is a helper of a few dozen lines that gets into a module only if used. Proxies have a
JS quirk: `options` is no longer `==` to the original object. So the compiler uses a proxy only
where an update would be lost without it.

### Two-way binding: `bind:`

```go
comp Signup() {
    state name = ""
    state age = 18
    state subscribed = false
    return <form>
        <input bind:value={name} placeholder="Name" />
        <input type="number" bind:value={age} />
        <label><input type="checkbox" bind:checked={subscribed} /> Subscribe</label>
        <p>Hello, {name == "" ? "stranger" : name}!</p>
    </form>
}
```

- **`bind:value`** is for `<input>`, `<textarea>` and `<select>`, of type `string`. A number can be
  bound to `<input type="number">` and `type="range"`: then `valueAsNumber` is used.
- **`bind:checked`** is for `<input>`, of type `bool`.
- **What can be bound:** anything assignable, a variable or a field (`bind:value={user.name}`,
  `bind:checked={todo.done}` in a list). Binding a constant, a `derived` or a component property is
  an error. Outside components `bind:` works too, but only one way: the user changes the variable,
  and changes of the variable do not show in the element.

If `name` changes not only in the input (for example, a "Reset" button writes `name = ""`), the
result is:

```js
$$input4.value = name;
$$input4.addEventListener("input", () => {
  name = $$input4.value;
  $$updateName2();
});
function $$updateName2() {
  if ($$input4.value !== name) $$input4.value = name;
  $$text6.data = name === "" ? "stranger" : name;
}
```

The check in `$$updateName2` keeps the cursor in place in an input the user is editing. The handler
does not update the input itself: if `name` changes only in it, the handler updates only the
greeting, and there is no `$$updateName2` at all.

### References: `ref`

```go
comp Chat() {
    state messages []string = ["Hi! Write something"]
    state draft = ""
    ref log
    ref input

    // Runs again after every new message: scrolls the list to the end
    effect {
        if messages.length > 0 {
            log.scrollTop = log.scrollHeight
        }
    }

    mount() {
        input.focus()
    }

    return <section class="chat">
        <ul class="log" ref={log}>{for message in messages { <li>{message}</li> }}</ul>
        <form onSubmit={event.preventDefault(); messages.push(draft); draft = ""}>
            <input ref={input} bind:value={draft} placeholder="Message" />
        </form>
    </section>
}
```

- **Declaration.** `ref name` at the top level of the body of a component or a decorator, like
  `state`. The markup gives it its element: `<ul ref={log}>`. Without a type the ref has the type
  of its element, here `HTMLUListElement`; a type can be written: `ref log HTMLElement`.
- **The element exists from the start.** It is created where the ref is declared, with its
  constant attributes: those written as a string (`class="log"`) or without a value (`hidden`),
  before any `{...spread}`, which may override them. The markup sets the rest where it is written:
  values in `{...}`, handlers, `bind:` and children. So above `return` `log` is an empty
  `<ul class="log">`, and markup can refer to an element further down:
  `<label for={input.id}>` before `<input id="name" ref={input} />`. In `mount()`, `effect` and
  handlers the element is complete. A ref is never `null`.
- **Once.** A ref points to one element, which the markup creates exactly once: in what a `return`
  gives, in `const x = <...>` at the top level of the body, in the children of components there,
  and in the wrapper of a decorator. Inside `{if}`, `{for}`, `{switch}`, expressions and functions
  the element is created again or many times, so a ref there is an error:
  `ref={item} is inside {for}: the element is created for every item, so a ref cannot point to it; put the element into a component, and each copy gets its own ref`.
  If an early `return` gives other markup, the element of the ref stays as it was declared, empty
  and outside the document.
- **A constant, not state.** A ref cannot be assigned, and what is done through it
  (`log.scrollTop = ...`) is ordinary work with the DOM.

```js
let messages = ["Hi! Write something"];
let draft = "";
const log = document.createElement("ul");
log.className = "log";
const input = document.createElement("input");
input.placeholder = "Message";
// ...the effect, mount() and the rest of the markup, which fills the elements in:
log.append($$for7);
input.value = draft;
input.addEventListener("input", () => {
  draft = input.value;
});
```

**A ref to a component.** `<Field ref={name} label="Name" />` points to the element at the top of
what `Field` creates, through the wrappers of its decorators. The ref creates that element in
advance, with its constant attributes, and `Field` fills it in. So the element must be known: one
`return` with an element, or with a component whose element is known; a wrapper that returns
markup, or what it got. Otherwise it is an error:
`ref cannot point to <Card>: it has several returns, so its element is not known in advance`.

Whether `Field` is inlined or becomes a function is the compiler's choice, so a ref works with both.
An inlined component fills the element in, under a name of its own (`$$root4`) if its own names
could hide the ref. A function gets it as its last argument, `$$root`, and creates one when it is
not given:

```js
function $$Field(label, $$root) {
  const $$label3 = $$root ?? document.createElement("label");
  $$label3.className = "field";
  // ...
}

// <Form>
const name = document.createElement("label");
name.className = "field";
// ...
const [$$field8] = $$Field("Name", name);
```

Only functions whose element is known and that a ref may point to have `$$root`: exported
components, those with a ref to them in the module, and those at the top of such components. If the
component has a ref to its own top element, both refs are the same element.

**In a decorator,** a ref is bound in its own markup, the wrapper. A decorator does not see the
component, so it cannot bind a ref in the component's markup:

```go
dec measured() {
    public state width = 0
    ref frame

    mount() {
        const observer = new ResizeObserver(() => { width = frame.clientWidth })
        observer.observe(frame)
        return () => observer.disconnect()
    }

    return (content Element) => <div class="measured" ref={frame}>{content}</div>
}
```

### Styles: `style`

```go
comp Meter(color string) {
    state percent = 10

    style {
        .meter { display: grid; gap: 8px }
        .fill {
            width: {percent}%;
            background: {color};
        }
        button:hover { opacity: 0.8 }
    }

    return <div class="meter">
        <div class="fill" />
        <button onClick={percent += 10}>+10%</button>
    </div>
}
```

- **Declaration.** `style { ... }` at the top level of the body of a component or a decorator,
  like `effect`; there can be several. Inside is CSS as it is written: rules, nested rules with
  `&`, `@media` and the rest. `style` is a keyword only at the start of a statement in a component,
  followed by `{`.
- **Scope.** Every element of the component's own markup gets the class of its style,
  `mango-<name>-<hash of the CSS>`, and so does every compound selector, before its
  pseudo-elements: `.fill` becomes `.fill.mango-meter-1n5i250`. So the rules reach neither other
  components nor the markup passed in as `children`, which is the parent's. `:global(...)` keeps a
  selector as it is: `:global(.dark) .fill`. A selector with `&` refers to the rule around it and is
  not given the class again. The names of `@keyframes` stay global for now.
- **Values from code.** `{expr}` is allowed only in the value of a declaration: `name:` followed by
  a space or a value is a declaration (`color: {c}`), `name:name` is a selector (`a:hover {`).
  The whole value becomes a CSS variable, `--mango-meter-1n5i250-0`, which the compiler sets on the
  element the component returns: when it is created, and again when what the value reads
  changes. So such a component returns an element, not a fragment. Values are strings or numbers,
  and they see the whole body, as the markup does.
- **Warnings.** A selector that no element of the markup can match by its tag, classes or id is a
  warning: `selector ".fil" matches no element of Meter`. An element with `class={...}` may have
  any class. Warnings do not stop compilation.
- **In a decorator** the style is for the markup of its wrapper, with a class of its own and values
  from the decorator.

```js
$$style("mango-meter-1n5i250", `.meter.mango-meter-1n5i250 {
  display: grid;
  gap: 8px;
}
.fill.mango-meter-1n5i250 {
  width: var(--mango-meter-1n5i250-0);
  background: var(--mango-meter-1n5i250-1);
}
button:hover.mango-meter-1n5i250 {
  opacity: 0.8;
}`);

// <Meter>
// ...
$$button5.addEventListener("click", () => {
  percent += 10;
  $$meter1.style.setProperty("--mango-meter-1n5i250-0", `${percent}%`);
});
$$button5.className = "mango-meter-1n5i250";
// ...
$$meter1 = $$div3;
$$meter1.style.setProperty("--mango-meter-1n5i250-0", `${percent}%`);
$$meter1.style.setProperty("--mango-meter-1n5i250-1", color);
```

`$$style` is a helper of a few lines: it adds a `<style>` with the CSS to `<head>` once, whichever
module comes first, so a component inlined into several modules has one copy on the page. A web
component (`@html-tag`) renders into a shadow root, which the styles of the page do not reach, so
it gets the CSS of its module there.

### CSS modules

The main way to style components is a CSS module next to them, a plain `.css` file:

```css
/* button.module.css */
.button { padding: 6px 14px; border-radius: 999px; }
.primary { background: var(--accent); color: white; }
.ghost:hover { background: var(--accent-soft); }
```

```go
import styles from "./button.module.css"

type Kind "primary" | "ghost"

export comp Button(kind Kind = "primary", children Content) {
    return <button class={`${styles.button} ${styles[kind]}`}>{children}</button>
}
```

- **The compiler reads the file.** Its classes get names of their own, `button_14zwdg2`, with the
  hash of the CSS, and `styles` is the object of those names. Its type has a `string` field for
  each class: `styles.buton` is a compile error, and `styles[kind]` is checked by the literal type
  of `kind`. Tags, `:root` and `:global(...)` stay global, so a module can hold the tokens of a
  theme.
- **The import is not imported.** It becomes `const styles = { button: "button_14zwdg2", ... }`,
  and the CSS is added to the page with `$$style`, like the styles of components. So CSS modules
  work with `mango build` and with Vite alike, but not in the playground, which has no files.
- **Warnings:** a class that the module never names is reported, unless it reads `styles` with a
  key that is not known (`styles[name]` with a `string`).
- **Several classes** are joined with a template string: there is no special syntax for it.

`style { ... }` in the component is for small styles that need values from code; a CSS module is a
file of its own, which editors and tools for CSS understand.

### Control flow in markup

Inside `{...}` in markup you can write ordinary `if`, `for` and `switch`. The elements in their
blocks are the content:

```go
<div>
    {if todos.length == 0 {
        <p class="empty">Nothing yet</p>
    } else {
        <ul>{for i, todo in todos {
            if !todo.hidden {
                <TodoItem {...todo} position={i + 1} />
            }
        }}</ul>
    }}
</div>
```

- **The syntax is that of the language:** `if` / `else if` / `else`, all forms of `for` and `switch`.
  The conditions are checked the same way, so they narrow types: after `if item != null`, `item` in
  the block is no longer `null`. A condition must be a `bool`: `if item` for a `?T` does not pass,
  write `if item != null`.
- **The blocks** hold elements, nested `if` / `for` / `switch` and `const`. Other statements
  (assignments, calls, `let`, `return`, `break`, `continue`) are errors: a markup block describes
  content, not actions. Text is written in a fragment: `{if ok { <>Done</> }}`.
- **`{expression}`** still works: `{ok ? <b /> : null}`, `{items.map(...)}`.
- **Spread of properties into a component** `<Product {...product} />` passes the object's fields
  named like the component's properties; other fields are ignored. Attributes after the spread
  override it.

**Compilation.**

- **If nothing in the construct depends on state** (and outside components), the result is ordinary
  JS: a loop or a condition that adds elements to the parent.

  ```js
  const $$ul1 = document.createElement("ul");
  for (const [i, product] of products.entries()) {
    if (product != null) {
      // <Product> ...
      $$ul1.append($$product2);
    }
  }
  ```

- **In live markup**, if the construct depends on state, a helper keeps its content between empty
  text nodes that serve as markers. Each block is a function that creates its content and returns
  its update:
  - `if` / `switch` → `$$branches`: the choice function returns the number of the branch. A branch
    is created again only when the choice changes; otherwise it is updated in place.
  - `for x in xs` → `$$list`: a block for each item. On an update the blocks are found by the array
    item itself (an object by reference, a string or a number by value). Blocks of items that stay
    are updated and moved, not created again, so the nodes and the state of the components inside
    them are kept. The index `i` is updated.
  - The classic `for let i = 0; ...` runs again on every update: there is nothing to find the blocks
    by.
  - A `const` in a block is recomputed on an update if it depends on state.

  ```js
  const [$$for5, $$updateFor5] = $$list(() => todos, (todo, i) => {
    const $$block6 = document.createDocumentFragment();
    // ...creating the content...
    return [$$block6, ($$index) => {
      i = $$index;
      $$text8.data = `${i + 1}. ${todo}`;
    }];
  });
  ```

  The update of a block runs when any state the block reads changes, and it updates all its parts.
  The helpers get into a module only if used, like `$$runDeferred`.

- When a branch or a list item is removed, the functions returned by the `mount()` of the
  components inside it run, nested blocks included. When `effect` appears, its `defer`s will run
  there too.

### Children and events of components

```go
comp Card(title string, children Content) {
    return <section class="card">
        <h2>{title}</h2>
        {children}
    </section>
}

<Card title="Profile">
    <p>The content of the card</p>
</Card>
```

- The `children` parameter of type `Content` gets the content between the tags. Its code is inlined
  where `{children}` is: these are slots without a runtime.
- Other pieces of markup are passed as ordinary properties: `<Layout header={<h1>My site</h1>} />`.
- Events going out are function properties, with the same handler rule as `on*` of elements:

```go
comp TodoItem(todo Todo, onToggle func(), onRemove func()) {
    return <li class={todo.done ? "todo done" : "todo"}>
        <input type="checkbox" checked={todo.done} onChange={onToggle} />
        <span>{todo.title}</span>
        <button title="Remove" onClick={onRemove}>×</button>
    </li>
}

<TodoItem todo={todo} onToggle={todo.done = !todo.done} onRemove={remove(todo.id)} />
```

Properties are read-only: a parameter cannot be assigned inside the component. To change the
parent's state, it is passed through a function property, like `onToggle` above.

### Decorators

> Implemented: declarations, arguments, public members with `get`, `mount()`, wrappers, `needs`
> and exporting. Not yet: renaming a decorator on import, a `return` inside the `if` or `for` of
> a wrapper, and combining decorators.

A decorator adds logic to a component: its own state, functions, `mount()` and a wrapper around
what the component returns. Components are not only markup, and the logic many of them share
(loading when visible, a 404 page, analytics, access checks) is written once, in a decorator. Like
a component, a decorator exists only at compile time: its code is inlined into every component it
is applied to.

```go
// Tells whether the component has come into view, with a margin
dec visible(margin string = "0px") {
    public state shown = false
    let node ?Element = null

    public func show() {
        shown = true
    }

    mount() {
        const observer = new IntersectionObserver(entries => {
            if entries.some(entry => entry.isIntersecting) {
                show()
                observer.disconnect()
            }
        }, { rootMargin: margin })
        if node != null {
            observer.observe(node)
        }
        return () => observer.disconnect()
    }

    // Changes nothing: only keeps the node for mount
    return (content Element) => {
        node = content
        return content
    }
}

@visible("300px")
comp Playground() {
    state source = ""

    func open(code string) {
        source = code
        @visible.show()
    }

    return <section>
        {if get(@visible.shown) {
            <Editor source={source} />
        }}
    </section>
}
```

- **Declaration.** `dec name(parameters) { ... }`. `dec` is a keyword only at the start of a
  declaration at the top level of a module; elsewhere it is an ordinary name. The parameters are
  written as for functions, but may have default values at the end: `margin string = "0px"`.
  `export dec` exports a decorator, and in another module it is inlined like a component.
- **The body** may hold `state`, `const`, `let`, `ref`, `style`, functions, `mount() { ... }` and, at the
  end, the `return` of a wrapper. Each of them is optional: a decorator without a wrapper only adds
  state and logic. Its refs are bound in the markup of its wrapper.
- **Application.** `@visible("300px")` before `comp`. The arguments are positional, as in a call of
  a function; without arguments the parentheses can be left out: `@notFound`. The arguments are
  evaluated for every instance in the scope of the component's parameters, so
  `@card(product.price)` works on `comp ProductCard(product Product)`. When the parameter changes,
  the decorator gets the new value, like a property of a child component.
- **Public members** — `public state`, `public derived`, `public const` and `public func` — are
  visible to the component:
  - reading is `get(@visible.shown)`; in markup it updates like a read of the component's own
    state;
  - calling is `@visible.show()`;
  - writing from outside is an error:
    `"shown" of @visible is read-only outside it; change it with one of its public functions, e.g. @visible.show()`.
    As with the properties of components, a decorator keeps its state consistent itself;
  - `get` is special only when its argument starts with `@`, so the program's own `get(url)` still
    works. `visible.shown` without `@` and `@visible.shown` outside `get` are errors that suggest
    `get(@visible.shown)`;
  - there is no `public let`: a value that changes and is read outside is a `state` (or a
    `derived` one, computed from state), and one that does not change is a `const`.

  Without `public`, members are visible only inside the decorator, where they are used by their
  plain names: `shown`, `show()`.

- **A decorator does not see the component:** neither its state nor its parameters, except through
  the arguments. So one decorator fits any component.
- **The wrapper** `return (content T) => ...` gets what the component returned, and what it returns
  is what the component returns in the end. The type of the parameter is written explicitly: the
  body of a decorator is checked once, by itself, not again at every application. The type also
  limits where the decorator can be applied: with `(form HTMLFormElement) => ...`, only to
  components that return a form. The type of `<Playground />` is the result of the outermost
  wrapper. The `return` must be a function literal. The wrapper is inlined where the component
  returns, so it returns once, at the end of its body.
- **The wrapper is called once,** at creation, like the body of a component. To change what is
  shown later, the wrapper's markup reads the decorator's state:

  ```go
  dec notFound() {
      state missing = false

      public func show() {
          missing = true
      }

      return (page Element) => <div class="page">{missing ? <NotFoundPage /> : page}</div>
  }
  ```

**Several decorators,** `@a @b comp X`:

- the bodies run from top to bottom: `a`, `b`, then the body of the component;
- the wrappers apply from bottom to top: the result of the component goes to `b`, and the result of
  `b` goes to `a`;
- `mount()` runs from the inside out: the component, `b`, `a`; the cleanup runs in the reverse
  order;
- a decorator applied twice is an error: `@a.x` would be ambiguous;
- `@html-tag` must be the first one: the element is built from the final result.

**Dependencies.** A decorator sees the public members of another one only if it names it with
`needs`:

```go
dec cart() {
    public state count = 0

    public func add() {
        count++
    }
}

dec cartBadge() needs cart {
    return (content Element) => <div class="with-badge">
        {content}
        <span class="badge">{get(@cart.count)}</span>
    </div>
}

@cart
@cartBadge
comp ProductCard(product Product) {
    return <article>
        <h2>{product.name}</h2>
        <button onClick={@cart.add()}>Add to cart</button>
    </article>
}
```

The body of `cartBadge` may read the state of `cart` at creation, so `cart` must already exist.
`@cartBadge` without `@cart`, or with `@cart` below it, is a compile error:
`@cartBadge needs @cart above it: @cart @cartBadge comp ...`. Several are listed with commas:
`dec checkout() needs cart, auth { ... }`.

**Compilation.** A decorator is inlined like a component: its body goes into the block of every
instance before the body of the component, with its names renamed. `get(@visible.shown)` becomes a
read of that variable and `@visible.show()` a call of that function, and the updates of the
decorator's state include the component's markup that reads it. The wrapper's markup is created
around the result of the component. There are no decorator objects and no runtime. A decorator of
another module uses the names of its module through hidden exports, `export { log as $$visible$log }`
there and `import { $$visible$log }` where it is applied; so it cannot assign the variables of its
module. The components of its module that its code uses go with it, as with an inlined component
of another module: those that are functions there are called, the others are inlined under tags of
their own, `<visible$Spinner />`. They cannot use components or decorators that their module
imports yet.

**Later:** a built-in higher-order decorator will combine several decorators into one. A program
cannot declare higher-order decorators of its own.

### Example: the test site with components

The same task list that was in `site/src/app.mango` (about 90 lines of manual DOM work):

```go
import { Todo, parseTitle } from "./todos.mango"
import { load, save } from "./storage.mango"

const FILTERS = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "done", label: "Done" },
]

comp TodoApp() {
    const saved, loadError = load()
    state todos = saved
    state title = ""
    state message = loadError?.message ?? ""
    state filter = "all"

    derived visible = todos.filter(todo => matches(todo, filter))
    derived left = todos.filter(todo => !todo.done).length

    // The list is saved on every change. save only reads it, so no proxy is needed.
    effect {
        save(todos)
    }

    func add() {
        const text, err = parseTitle(title)
        if err != null {
            message = err.message
            return
        }
        todos.push({ id: Date.now(), title: text, done: false })
        title = ""
        message = ""
    }

    return <main>
        <form onSubmit={event.preventDefault(); add()}>
            <input bind:value={title} placeholder="What to do?" />
            <button>Add</button>
        </form>
        {if message != "" {
            <p class="message">{message}</p>
        }}
        <nav>
            {for f in FILTERS {
                <button class={f.id == filter ? "active" : ""} onClick={filter = f.id}>{f.label}</button>
            }}
        </nav>
        <ul>
            {for todo in visible {
                <TodoItem
                    todo={todo}
                    onToggle={todo.done = !todo.done}
                    onRemove={todos = todos.filter(t => t.id != todo.id)}
                />
            }}
        </ul>
        <footer>Left: {left}</footer>
    </main>
}

func matches(todo Todo, filter string) bool {
    switch filter {
    case "active":
        return !todo.done
    case "done":
        return todo.done
    default:
        return true
    }
}

document.body.append(<TodoApp />)
```

In JS this becomes the code that creates the nodes, one update function per state and `$$list` for
the task list. There are no proxies or function components here. `TodoItem` is inlined into the
body of `for`: the code of one row of the list is written there once, and no extra lines appear.

## How this differs from known approaches

|                                | React (JSX)               | Svelte / Solid                 | MangoScript                                                       |
| ------------------------------ | ------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| The result of `<div>`          | a description (VDOM)      | a DOM node (Solid)             | a DOM node                                                        |
| A component at runtime         | a function                | a function                     | none: the code is inlined (a function only if large or recursive) |
| How updates are found          | VDOM diffing              | the compiler + runtime signals | the compiler; proxies only for values that go into unknown code   |
| The handler `onClick={save()}` | called on render          | called on render               | called on a click                                                 |
| Cleaning up effects            | a function from an effect | `onCleanup` / return           | the function returned by `mount()`                                |
| Shared logic of components     | hooks, HOCs               | actions (Svelte), primitives   | decorators `dec`, inlined                                         |
| A reference to an element      | `useRef`, set on render   | `bind:this` / `ref`, set later | `ref input`: the element exists from the start of the body        |

## What the compiler needs

- **The lexer:** a markup mode (text, attributes) driven by the parser.
- **The parser:**
  - the nodes `ElementExpression`, `Attribute`, `TextChild`, `ExpressionChild`;
  - `if` / `for` / `switch` in markup;
  - the declaration `ComponentDeclaration` with `state`, `derived` and `effect`.
- **Types:** the DOM among the built-ins; attributes, `bind:` and component properties; the rules of
  `state`, `derived`, `effect`.
- **Analysis:**
  - dependencies of markup, `derived` and `effect` on state;
  - places of writing;
  - whether a function changes its parameter;
  - recursion of components;
  - the size of inlining.
- **Generation:**
  - creating nodes;
  - inlining components with renaming, and function components;
  - update functions;
  - `if` / `for` / `switch` in markup;
  - the helpers `$$list` and `$$reactive`.

## Stages

1. ~~**Elements without components.** Static, with properties, events and DOM types.~~ Done:
   `renderItem` of the test site went from 25 lines to 6.
2. ~~**Components without state:** inlining, properties, `children`, an error for recursion.~~
   Done: a row of the test site's list is the `TodoItem` component, inlined into `render()`.
   Besides what is described above, the compiler checks that the module names a component uses are
   not hidden where it is inlined.
3. ~~**`state`** with updates of text and attributes; `bind:`.~~ Done, see "How updates work".
   Besides text and attributes, nodes that depend on state and the properties of child components
   are updated. The test site became a `TodoApp` component with `state` and `bind:` instead of a
   `render()` function that rebuilt the page by hand.
4. ~~**`if`, `for` and `switch` in markup.**~~ Done, see "Control flow in markup". Instead of
   `@if` / `@for ... key`, ordinary `if` / `for` / `switch` inside `{...}`, and the blocks of a list
   are found by the item itself, without a key. Spread of properties into a component came along.
   The test site shows the filters, the tasks and the message with `{for}` and `{if}`.
5. ~~**`derived` and `effect`**~~ (done, with `mount()`). An effect runs once the markup is created
   and again after the updates of what it reads while it runs; one after an early `return` does
   not run again, like the markup there.
6. ~~**Function components**~~ (recursion, exported components and the 100-line threshold are
   done) **and proxies** for state that goes into unknown code.
7. **State shared by several components.**
8. **Decorators (`dec`):** ~~public members, `get`, `mount()`, wrappers and `needs`~~ (done);
   ~~exporting decorators~~ (done); later combining them.

## Decisions

1. **State is declared with keywords:** `state count = 0`, `derived double = count * 2`,
   `effect { ... }`.
2. **Recursive components:** a compile error in the first version, then compilation to a function.
   They compile to functions now.
3. **Proxies only where there is no way around them:** for arrays and objects that go into code the
   compiler cannot see, or into functions that change them.
4. **Two-way binding is `bind:value` and `bind:checked`.**
5. **State shared by several components** will come later; for now it is passed through properties.
6. **The inlining threshold:** if inlining adds more than 100 extra lines of code, the component
   becomes a function.
7. **Conditions and loops in markup are ordinary `if`, `for` and `switch` inside `{...}`**, with no
   separate syntax like `@if`: `<div>{for product in products { <Product {...product} /> }}</div>`.
8. **Mounting is `mount() { ... }` in a component's body.** It runs only when the component's
   markup is in the document: that is checked in a microtask after creation, and markup that is not
   in the document yet is waited for with a `MutationObserver`, which watches only while some markup
   waits. The first node is taken right after the markup is created, since a fragment is empty once
   inserted. The function `mount` returns runs when `{if}`, `{switch}` or `{for}` removes the
   markup. For that, blocks are created with an "owner" that collects the cleanup of the block's
   components and of the nested blocks. The owner of the current block is shared by the modules of a
   page (`Symbol.for("mangoscript.owner")`), because a block of one module can hold components of
   another. Removing markup by the program's own code is not tracked: that would need an observer of
   the whole document all the time, and the cleanup would run asynchronously.
9. **Web components are `@html-tag comp ...`.** The tag comes from the component's name in kebab
   case or from the decorator, `@html-tag("app-card")`; a name without a hyphen is a compile error
   rather than a guess. Such a component is compiled to a function, like a recursive one, and a
   class of a custom element calls it in `connectedCallback` and renders into a shadow root.
   Attributes are converted by the type of the property (string, `Number()`, presence for bool);
   arrays, objects and functions are only JS properties. Disconnection removes the markup in a
   microtask, unless the element is back by then, so moving it keeps the state. The element is
   defined at the end of the module, so that it never runs before the names it uses have values.
10. **Shared logic of components is decorators, `dec name(...) { ... }`,** applied at compile time
    (see "Decorators"). Not for the component's own state: for logic added to it. The arguments are
    positional, evaluated in the scope of the component's parameters. Public members are
    `public state`, `public derived`, `public const` and `public func`, with no `public let`; outside they are read
    with `get(@name.member)` and called as `@name.f()`, and writing them from outside is an error.
    The type of the wrapper's parameter is written explicitly. One decorator sees another only
    through `needs`, and the one it needs must be applied above it. A decorator applied twice is an
    error. Programs cannot declare higher-order decorators: only a built-in one will combine
    decorators.
11. **A component of another module is inlined or called by the same 100-line threshold:**
    `export comp` makes it a function in its module, `export function $$Card`, which that module
    calls itself. Another module inlines it with the components of its module it uses, and gets the
    names of that module through hidden exports.

12. **References to elements are `ref name` in the body and `ref={name}` in the markup.** The
    element is created where the ref is declared, with its constant attributes, so the ref has it
    from the start and is never `null`; the markup fills it in. So the markup must create it once:
    a ref inside `{if}`, `{for}`, `{switch}`, expressions or functions is an error.
    `<Card ref={card} />` points to the element at the top of what `Card` creates, which must be
    known in advance: an inlined `Card` fills it in, and a function gets it as `$$root`. Elements
    are still created with `createElement` and a statement per attribute: the second argument of
    `createElement` takes no attributes, and `Object.assign` or a helper were slower when measured
    and no shorter after minification.
13. **Styles are `style { ... }` blocks of CSS in the body, scoped as in Svelte:** a class on every
    element of the component's own markup and in every selector, with `:global(...)` to leave the
    scope. Values from code are `{expr}` in the values of declarations, as in markup, and become CSS
    variables of the element the component returns. The module adds its CSS to the page with
    `$$style`, so styles work without a bundler and in the playground. A selector that matches no
    element is a warning: the compiler got warnings, which do not stop compilation, with styles.
14. **The main way to style components is a CSS module,** `import styles from "./x.module.css"`,
    which the compiler reads itself: typed classes with names of their own, and the CSS added to the
    page by the module, so it works without a bundler. Several classes are joined with template
    strings, without a syntax of their own.

## Not decided yet

1. **Whether to report where the compiler did not inline.** Function components and proxies are
   implicit decisions that affect the output. I propose a `mango build --explain` flag that lists
   them: "`Card` became a function: 140 extra lines", "`options` is wrapped in a proxy: passed to
   `confetti`".
2. **The 100-line threshold: a constant or a setting.** I propose a constant for now, and a setting
   (`--inline-limit`) when a real need appears. For now it is the constant `INLINE_LIMIT` in
   `src/codegen/js.ts`.
3. **An explicit key for `for`.** Now the blocks of a list are found by the item itself. If the
   array is replaced with new objects with the same data (loaded again from a server, for example),
   all the blocks are created again. If that becomes a problem, a key can be added, for example
   `for todo in todos key todo.id`.
4. **A `derived` of several statements.** Now it is `derived x = expression`. A block form
   `derived total number { ... return sum }` could be added. I propose only the expression in the
   first version: complex logic can go into a function.
5. **Combining decorators.** The syntax of the built-in higher-order decorator is open, and so is
   how it works with the rest: whether the public members of the combined decorators are read as
   `get(@card.count)` or through the name of the combination, whether a combination containing
   `cart` satisfies `needs cart`, and whether `@cart` next to a combination containing it counts as
   applied twice.
6. **A component that returns `null` for a wrapper.** A 404 page could be a wrapper
   `(page ?Element) => ...` that shows it when the component returns `null`. Now a component returns
   markup only, and the choice between `return`s is made once, at creation; the reactive way is the
   decorator's state, as in `notFound` above.
7. **Refs in `{if}`, `{switch}` and `{for}`.** An element that exists only sometimes could be a ref
   of type `?T`, and the elements of a list an array. For now such an element goes into a component
   with a ref of its own.
8. **`public ref` in decorators,** for the component to read the element of the wrapper.
9. **One ref in several `return`s.** Only one `return` runs, so a ref could be bound in each of them
   when their tags are the same; the same would let a ref point to a component with several
   `return`s.
10. **Scoped names of `@keyframes`.** Now they are global, as in plain CSS.
11. **The CSS in a file of its own**, `app.css` next to `app.js` or a CSS module for Vite, instead of
    `$$style`: it would be cached apart from the code.
12. **The class of a style only on the elements that some selector can match**, as in Svelte, to
    make the code shorter.
