# Rook for VS Code

**English** · [Русский](README.ru.md)

Support for Rook, a language with the semantics of JavaScript, Go-style syntax and static
types, in `.rk` files: highlighting, errors as you type and completion.

## Errors and completion

The extension starts a language server with the Rook compiler. While you type, it underlines
the errors and warnings that `rook build` would print, and it completes:

- names in scope: variables, parameters, functions, classes, components, globals such as `document`,
  and keywords;
- members after `.` and `?.`, with their types: of classes (private ones only inside the class),
  interfaces, objects, strings, arrays and the DOM;
- types where a type is written: `let user Us|`;
- tags and components in markup, `<Ca|`, and the properties of a component or the attributes and
  events of an element, `<input on|`.

The types of the standard library and the DOM come from TypeScript's lib files, which the extension
carries. Imports of other `.rk` files and of packages with types are checked as in `rook build`.
Markup and components are errors unless the nearest `package.json` turns them on with
`"rook": { "markup": true }`, as for `rook build`.

## Highlighting

It highlights:

- keywords, the declarations `func`, `comp`, `class`, `interface`, `type`, `state` and `mount()`;
- Go-style types: `number`, `[]Todo`, `?User`, names of classes and interfaces;
- strings, template strings with `${...}`, numbers, comments;
- markup: tags, components, attributes, `on*`, `bind:value`, expressions in `{...}`, and `if`,
  `for` and `switch` inside it.

The extension also sets up comments (`Cmd+/`), closing brackets and quotes, and a 4-space indent.

## Installation

Search for "Rook Language" in the Extensions view of VS Code, or install it from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Qwern9876r.rooklang).
VSCodium, Cursor and other editors that use [Open VSX](https://open-vsx.org/extension/Qwern9876r/rooklang)
find it there. From the command line:

```sh
code --install-extension Qwern9876r.rooklang
```

The extension carries its own copy of the compiler, so it needs nothing else. To build and run
`.rk` files, install the compiler too: `npm install --save-dev rooklang`.

## Limitations

As with `rook build`, a file with a syntax error shows only its syntax errors: the types are
checked once it parses. A file sees the other `.rk` files it imports as they are saved on disk.

The highlighting is a TextMate grammar: it looks at the text of a line, not at a syntax tree. So:

- `<` is taken as the start of markup if there is no value before it (a name, `)` or `]`) and a tag
  name right after it. `a < b` and `i<n` are comparisons, and `return <div>` is markup;
- types are recognized by their look: the built-in ones (`number`, `string`…) and names with a
  capital letter. Your own types with a lowercase letter (`type id = number`) are highlighted as
  ordinary names.
