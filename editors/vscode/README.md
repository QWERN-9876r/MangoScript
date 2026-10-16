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

From the root of the repository:

```sh
npm run vscode:install
```

The command bundles the client and the language server with the compiler into
`editors/vscode/dist` (`npm run vscode:build`), packs `editors/vscode/rooklang.vsix` and installs
it with `code`. After changes to the grammar or the compiler, run it again and reload the VS Code
window.

For working on the extension, a window with it loaded straight from this folder is handier; build it
first:

```sh
npm run vscode:build
code --extensionDevelopmentPath="$PWD/editors/vscode"
```

The sources of the extension are in `src/`: `extension.mts` starts the server, `server.mts` answers
VS Code, and completion itself is in the compiler (`src/completion.ts` and the last layer of the
checker, `src/checker/completion.ts`). They are tested in `tests/completion.test.ts` and
`tests/vscode-server.test.ts`.

The grammar is checked by the tests in `tests/vscode-grammar.test.ts` with the same engine that VS
Code uses (`vscode-textmate`). The scopes under the cursor are shown by the command
"Developer: Inspect Editor Tokens and Scopes".

## Limitations

As with `rook build`, a file with a syntax error shows only its syntax errors: the types are
checked once it parses. A file sees the other `.rk` files it imports as they are saved on disk.

The highlighting is a TextMate grammar: it looks at the text of a line, not at a syntax tree. So:

- `<` is taken as the start of markup if there is no value before it (a name, `)` or `]`) and a tag
  name right after it. `a < b` and `i<n` are comparisons, and `return <div>` is markup;
- types are recognized by their look: the built-in ones (`number`, `string`…) and names with a
  capital letter. Your own types with a lowercase letter (`type id = number`) are highlighted as
  ordinary names.
