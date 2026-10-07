# MangoScript for VS Code

**English** · [Русский](README.ru.md)

Syntax highlighting for MangoScript, a language with the semantics of JavaScript, Go-style syntax
and static types, in `.mango` files.

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

The command builds `editors/vscode/mangoscript.vsix` and installs it with `code`. After changes to
the grammar, run it again and reload the VS Code window.

For working on the grammar, a window with the extension loaded straight from this folder is
handier:

```sh
code --extensionDevelopmentPath="$PWD/editors/vscode"
```

The grammar is checked by the tests in `tests/vscode-grammar.test.ts` with the same engine that VS
Code uses (`vscode-textmate`). The scopes under the cursor are shown by the command
"Developer: Inspect Editor Tokens and Scopes".

## Limitations

This is a TextMate grammar: it looks at the text of a line, not at a syntax tree. So:

- `<` is taken as the start of markup if there is no value before it (a name, `)` or `]`) and a tag
  name right after it. `a < b` and `i<n` are comparisons, and `return <div>` is markup;
- types are recognized by their look: the built-in ones (`number`, `string`…) and names with a
  capital letter. Your own types with a lowercase letter (`type id = number`) are highlighted as
  ordinary names.
