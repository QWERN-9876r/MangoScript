# MangoScript

**English** · [Русский](README.ru.md)

A language with the semantics of JavaScript, Go-style syntax and static types. It compiles to
JavaScript (WebAssembly is planned).

```go
func divide(a, b number) (number, error) {
    if b == 0 {
        return 0, error("division by zero")
    }
    return a / b, null
}

const q, err = divide(10, 4)
```

The guide with examples and a playground: <https://qwern-9876r.github.io/MangoScript/>.
Specification: [docs/spec.md](docs/spec.md), design of components:
[docs/components.md](docs/components.md), an example: [examples/hello.mango](examples/hello.mango).

## Requirements

Node.js ≥ 24 (`nvm use`). The compiler is written in TypeScript, and Node runs the `.ts` files
directly, so development needs no build step.

## Commands

| Command                              | What it does                                               |
| ------------------------------------ | ---------------------------------------------------------- |
| `npm run mango -- build file.mango`  | Compile to `file.js`, with the `.mango` modules it imports |
| `npm run mango -- run file.mango`    | Compile and run                                            |
| `npm run mango -- tokens file.mango` | Show the lexer's tokens                                    |
| `npm run mango -- ast file.mango`    | Show the syntax tree                                       |
| `npm test` / `npm run test:watch`    | Tests (Vitest)                                             |
| `npm run typecheck`                  | Type check                                                 |
| `npm run lint` / `npm run format`    | ESLint / Prettier                                          |
| `npm run check`                      | All at once: types, lint, format, tests                    |
| `npm run build`                      | Build to `dist/` (the `mango` binary)                      |
| `npm run vscode:install`             | Build and install the VS Code extension                    |

Options of `build`: `--out-dir dir` writes the `.js` files to a separate folder, `--stdout` prints
the JS of one file, `--no-check` skips type checking.

## Highlighting in VS Code

[editors/vscode/](editors/vscode/) has an extension that highlights `.mango` syntax: code, types and
markup. `npm run vscode:install` builds it and installs it with `code`; see
[editors/vscode/README.md](editors/vscode/README.md).

## Documentation site

[site/](site/) holds the MangoScript guide in English (`index.html`) and Russian
(`ru/index.html`). Both the page and its server are written in MangoScript, and the compiler runs
right in the browser: every example has a tab with the JavaScript it compiles to and a run button,
and the bottom of the page has a playground.

- [site/src/en/](site/src/en/) and [site/src/ru/](site/src/ru/): the text of the sections in each
  language, listed in `guide.mango`; the sections about markup and components are in
  `guide-components.mango`;
- [site/examples/](site/examples/) and [site/examples/ru/](site/examples/ru/): the examples; tests
  check that they all compile and that each has a translation;
- [site/src/i18n.mango](site/src/i18n.mango): the language of the page and the texts around the
  guide;
- [site/src/example.mango](site/src/example.mango) and
  [site/src/playground.mango](site/src/playground.mango): the example with tabs and the playground,
  components with `state`, `bind:` and `{if}` / `{for}`;
- [site/src/highlight.mango](site/src/highlight.mango): code highlighting with the compiler's lexer;
- [site/server.mango](site/server.mango): a static server on `node:http` with a log through `defer`.

Vite builds the site ([vite.config.ts](vite.config.ts)): the plugin [src/vite.ts](src/vite.ts)
compiles `.mango` modules with type checking, the playground's compiler comes straight from
[src/browser.ts](src/browser.ts), and the code of the examples gets into the bundle from the
`virtual:examples/en` and `virtual:examples/ru` modules.

```sh
npm run site:dev    # the Vite dev server: changes show up right away
npm run site        # builds the site to site/dist and runs site/server.mango at http://localhost:3000
```

## Vite

The plugin from [src/vite.ts](src/vite.ts) adds MangoScript to any Vite project:

```ts
import { defineConfig } from 'vite';
import { mango } from './src/vite.ts';

export default defineConfig({ plugins: [mango()] });
```

Then `.mango` files can be imported from JS, TS and other `.mango` modules. Type errors stop the
build, and in development they show up over the page.

## Conventions

- Imports are written with the `.ts` extension (`import { x } from './lexer.ts'`).
- Only erasable TS syntax: instead of `enum`, unions of strings or `as const` objects.
- Text for people is written in English first (README, docs, the site, examples, comments); the
  Russian versions are next to it: `README.ru.md`, `docs/*.ru.md`, `site/examples/ru/`.
