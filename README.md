# MangoScript

**English** · [Русский](README.ru.md)

A language with the semantics of JavaScript, Go-style syntax, goroutines on real threads and static
types. It compiles to readable JavaScript without a runtime (WebAssembly is planned).

```go
async func square(jobs <-chan number, results chan<- number) {
    for n in jobs {
        results <- n * n
    }
}

const jobs = chan<number>(10)
const results = chan<number>()
go square(jobs, results)            // another thread, at once with the rest
go square(jobs, results)

for let n = 1; n <= 4; n++ {
    jobs <- n
}
close(jobs)
for let i = 0; i < 4; i++ {
    console.log(<-results)
}
```

- **Goroutines and channels.** `go f(x)` runs a function as a goroutine, on another processor, and
  channels, `select`, `after`, `tick` and `cancel` work as in Go; `go for i, v in pixels { ... }`
  splits an array among the processors. The compiler checks that what goes to another thread can be
  copied there.
- **Go syntax.** `func`, the type after the name, several results, errors as a second value,
  `defer`, a single `for` loop:

  ```go
  func divide(a, b number) (number, error) {
      if b == 0 {
          return 0, error("division by zero")
      }
      return a / b, null
  }
  ```

- **Static types with null safety.** A `?User` cannot be used without a check.
- **JavaScript inside.** The same values, classes and modules, any JS library; markup creates real
  DOM elements, and components are compiled away.

The guide with examples and a playground: <https://qwern-9876r.github.io/MangoScript/>.
Specification: [docs/spec.md](docs/spec.md), design of components:
[docs/components.md](docs/components.md), an example: [examples/hello.mango](examples/hello.mango).

## Installation

MangoScript needs Node.js ≥ 24.

```sh
npm install --save-dev mangoscript
npx mango build app.mango                # app.js next to the source
npx mango build src --out-dir dist       # every module of a folder
npx mango run app.mango                  # compile and run
```

From code, the compiler is `import { compile } from 'mangoscript'`. The package also has the
[Vite](#vite) plugin, `mangoscript/vite`, and `mangoscript/browser`, the compiler without the
TypeScript compiler for running in a browser, as in the site's playground: there imports are not
type checked.

## Development

Node.js ≥ 24 (`nvm use`). The compiler is written in TypeScript, and Node runs the `.ts` files
directly, so development needs no build step: the commands below run the compiler from `src/`.
`dist/` is built only for the npm package.

`npm install` also installs a pre-commit hook that formats the staged files: ESLint adds the blank
lines between statements that Prettier keeps but never adds, then Prettier formats. Only the
staged version is formatted, so edits that are not staged stay out of the commit.

## Commands

| Command                              | What it does                                               |
| ------------------------------------ | ---------------------------------------------------------- |
| `npm run mango -- build file.mango`  | Compile to `file.js`, with the `.mango` modules it imports |
| `npm run mango -- run file.mango`    | Compile and run                                            |
| `npm run mango -- tokens file.mango` | Show the lexer's tokens                                    |
| `npm run mango -- ast file.mango`    | Show the syntax tree                                       |
| `npm test` / `npm run test:watch`    | Tests (Vitest)                                             |
| `npm run typecheck`                  | Type check                                                 |
| `npm run lint` / `npm run format`    | ESLint / Prettier with the blank lines from ESLint         |
| `npm run check`                      | All at once: types, lint, format, tests                    |
| `npm run build`                      | Build the npm package to `dist/`                           |
| `npm run vscode:install`             | Build and install the VS Code extension                    |

Options of `build`: `--out-dir dir` writes the `.js` files to a separate folder, `--stdout` prints
the JS of one file, `--no-check` skips type checking. `--markup` and `--no-markup` turn markup and
components on or off for all files (with `run` too); by default they are off, and a package turns
them on in its `package.json`: `"mangoscript": { "markup": true }`.

## Releases

A release is a new version in `package.json` on `main`: `npm version minor --no-git-tag-version`
(or `patch`) changes it, and the push to `main` releases it. The workflow
[.github/workflows/publish.yml](.github/workflows/publish.yml) sees that npm does not have this
version yet, runs `npm run check`, builds `dist/`, publishes the package to npm and tags the commit
`v0.2.0`. A push that keeps the version publishes nothing.

## VS Code

[editors/vscode/](editors/vscode/) has an extension for `.mango` files: highlighting of code, types
and markup, errors as you type and completion of names, members, types, tags and attributes, from a
language server with the compiler. `npm run vscode:install` builds it and installs it with `code`;
see [editors/vscode/README.md](editors/vscode/README.md).

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
- [site/src/editor/](site/src/editor/): the editor of the playground, the one of VS Code (Monaco)
  with the grammar of the VS Code extension, the compiler's errors under the code and its
  completion; TypeScript for the browser, checked with [site/tsconfig.json](site/tsconfig.json);
- [site/server.mango](site/server.mango): a static server on `node:http` with a log through `defer`.

Vite builds the site ([vite.config.ts](vite.config.ts)): the plugin [src/vite.ts](src/vite.ts)
compiles `.mango` modules with type checking, the playground's compiler comes straight from
[src/browser.ts](src/browser.ts), and the code of the examples gets into the bundle from the
`virtual:examples/en` and `virtual:examples/ru` modules. The compiler is a chunk of its own,
loaded by [site/src/compiler.ts](site/src/compiler.ts) on the first run, when a JavaScript tab is
opened and when the playground comes into view: the page itself needs only the lexer, for
highlighting. The editor of the playground, some 3.5 MB, is loaded then too; until it is, and on
touch screens, the playground has a text area of its own.

```sh
npm run site:dev    # the Vite dev server: changes show up right away
npm run site        # builds the site to site/dist and runs site/server.mango at http://localhost:3000
```

## Vite

The plugin `mangoscript/vite` ([src/vite.ts](src/vite.ts)) adds MangoScript to any Vite project:

```ts
import { defineConfig } from 'vite';
import { mango } from 'mangoscript/vite';

export default defineConfig({ plugins: [mango()] });
```

Then `.mango` files can be imported from JS, TS and other `.mango` modules. Type errors stop the
build, and in development they show up over the page. Markup and components are off by default,
so `.mango` modules fit a React, Svelte or Vue app as they are; turn them on with
`"mangoscript": { "markup": true }` in `package.json`, or `mango({ markup: true })`.

## Conventions

- Imports are written with the `.ts` extension (`import { x } from './lexer.ts'`).
- Only erasable TS syntax: instead of `enum`, unions of strings or `as const` objects.
- Text for people is written in English first (README, docs, the site, examples, comments); the
  Russian versions are next to it: `README.ru.md`, `docs/*.ru.md`, `site/examples/ru/`.
