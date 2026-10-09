# Elements and components — design

**English** · [Русский](components.ru.md)

> Status: implemented are elements, components, `state`, `bind:`, `if` / `for` / `switch` in markup
> (stages 1–4), recursive components, early returns, `mount()` and web components (`@html-tag`);
> `derived` and `effect` are not yet. The decisions made are collected at the end of the document, together with what is not
> decided yet.

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
`append`. A separate mechanism of references (`ref`) is not needed:

```go
const input = <input placeholder="Name" />
input.focus()
form.append(input)
```

### Types

| Literal               | Type                                         |
| --------------------- | -------------------------------------------- |
| `<a>`, `<input>`, ... | `HTMLAnchorElement`, `HTMLInputElement`, ... |
| an unknown tag        | `HTMLElement`                                |
| `<>...</>`            | `DocumentFragment`                           |

This needed the DOM among the built-in types: `Node`, `HTMLElement` and the most common elements,
`Event` and its variants, the type of `document`. Done: in Node the DOM types come from TypeScript's
`lib.dom`, and the browser compiler has hand-written ones.

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

| Construct                               | What it does                                                     |
| --------------------------------------- | ---------------------------------------------------------------- |
| `state count = 0`, `state items []Todo` | a reactive variable, like `let`; without a value, the zero value |
| `derived double = count * 2`            | a computed value, read-only, like `const`                        |
| `effect { ... }`                        | code that runs after creation and whenever what it reads changes |

The type can be written as with `let`: `state count number = 0`, `derived left number = ...`.

`state`, `derived` and `effect` are keywords only at the start of a statement inside `comp`. In
other code they are ordinary names: `let state = load()` can still be written (the same way as
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

A component from another module (`export comp`) is inlined the same way. The compiler reads imported
`.mango` modules for their types already, and will take the component's body from there too. A
component cannot be called from JS: outside MangoScript it does not exist.

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

Inlining is not always possible. In two cases the compiler makes a function of a component:

1. **The component is recursive** (a tree, nested comments), directly or through other components.
   This is implemented, see below.
2. **Inlining adds more than 100 extra lines.** Extra lines are the total size of all the inlined
   copies minus the size of one function and its calls. A component used once is always inlined.

Such a function is a detail of compilation: it is not among the module's exports, and its name is
internal (`$$Tree`). It gets the properties as arguments and returns the node and a function that
sets the properties again:

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
5. **`derived` and `effect`** (`mount()` is done).
6. **Function components** (recursion is done; the 100-line threshold is not yet) **and proxies** for
   state that goes into unknown code.
7. **State shared by several components.**

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

## Not decided yet

1. **Whether to report where the compiler did not inline.** Function components and proxies are
   implicit decisions that affect the output. I propose a `mango build --explain` flag that lists
   them: "`Card` became a function: 140 extra lines", "`options` is wrapped in a proxy: passed to
   `confetti`".
2. **The 100-line threshold: a constant or a setting.** I propose a constant for now, and a setting
   (`--inline-limit`) when a real need appears.
3. **An explicit key for `for`.** Now the blocks of a list are found by the item itself. If the
   array is replaced with new objects with the same data (loaded again from a server, for example),
   all the blocks are created again. If that becomes a problem, a key can be added, for example
   `for todo in todos key todo.id`.
4. **A `derived` of several statements.** Now it is `derived x = expression`. A block form
   `derived total number { ... return sum }` could be added. I propose only the expression in the
   first version: complex logic can go into a function.
