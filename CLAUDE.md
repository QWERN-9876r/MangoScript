# MangoScript — rules for Claude Code

MangoScript is a language with JavaScript semantics, Go-style syntax and static types. It compiles
to readable JavaScript without a runtime library. The compiler is written in TypeScript and runs on
Node 24. The specification with the reasons for its decisions is in `docs/spec.md`, the design of
markup and components in `docs/components.md`.

## Working with the maintainer

- The maintainer writes in Russian: answer in Russian.
- **The maintainer decides the syntax.** Do not invent syntax or change the meaning of existing
  constructs on your own: offer a few options side by side, with a recommendation, and ask.
- Commit and push only when asked. Pushing to `main` deploys the site
  (https://qwern-9876r.github.io/MangoScript/) through `.github/workflows/pages.yml`, so confirm
  before every push.
- The working tree may hold the maintainer's own uncommitted edits (e.g. `examples/hello.mango`).
  Do not commit, stash or revert them: stage files by name, not with `git add -A`.
- Commit messages: an English subject in the imperative ("Add @html-tag: ..."), then a body that
  says what changed and why.

## Commands

```sh
npm run check                         # tsc, eslint, prettier --check, vitest: run before saying "done"
npx vitest run tests/html-tag.test.ts # one test file
npm run mango -- build app.mango      # compile (app.js next to the source); `run` compiles and runs
node src/cli.ts ast file.mango        # print the AST
npm run site:dev / site:build / site  # the docs site: Vite dev server / build / build and serve
npm run vscode:install                # rebuild and install the VS Code extension
npm run format                        # prettier --write
```

## Code rules

- **No code file is longer than 400 lines** (`.ts`, `.js`, `.mango`, `.css`, `.html`, `.json`;
  Markdown is not counted). ESLint `max-lines` and `tests/repository.test.ts` enforce it. Split by
  responsibility before a file reaches the limit, as the existing code does.
- Node runs the `.ts` files directly (type stripping): only erasable TypeScript (no `enum`,
  `namespace`, parameter properties), relative imports end in `.ts`, types are imported with
  `import type`.
- The lexer, parser, checker, code generator and TypeScript converter are **chains of layer
  classes**, one area per file. The order of each chain is in the comment at the top of its
  `base.ts` (`src/codegen/emitter.ts` for the generator). A method that an earlier layer calls but a
  later one implements is declared `protected abstract` in the base and implemented with
  `protected override`. A new area becomes a new layer file inserted into the chain.
- `src/ast.ts` and `src/checker/types.ts` are barrels over `src/ast/` and `src/checker/types/`.
  `src/checker/types/model.ts` must not have runtime imports: that would create an ESM cycle.
- `src/browser.ts` is the compiler of the site's playground: it has no TypeScript compiler. Code in
  `src/typescript/` (types from `.d.ts` and `lib.dom`) is Node-only and must not be imported from
  it; without it the checker falls back to `src/checker/builtins.ts` and `src/checker/dom.ts`.
- Names in generated JS start with `$$`; MangoScript code cannot use such names. Runtime helpers
  are in `src/codegen/helpers.ts`, with their dependencies in `HELPER_NEEDS`.
- Diagnostics: English, lowercase, and say how to fix the problem, with an example where it helps:
  `"page" ... must have a hyphen; give one, e.g. @html-tag("app-page")`.
- Comments are in English and explain why, at the density of the surrounding code.

## Documentation and the site

- **English is the default language everywhere**, Russian goes alongside, and both are kept in sync
  in the same change:

  | English                   | Russian                      |
  | ------------------------- | ---------------------------- |
  | `README.md`               | `README.ru.md`               |
  | `docs/spec.md`            | `docs/spec.ru.md`            |
  | `docs/components.md`      | `docs/components.ru.md`      |
  | `site/src/en/` (site `/`) | `site/src/ru/` (site `/ru/`) |
  | `site/examples/*.mango`   | `site/examples/ru/*.mango`   |

- The site is itself a MangoScript program (`site/src`, server `site/server.mango`), built by Vite
  with the plugin `src/vite.ts`. `tests/site.test.ts` compiles it, compiles every example with the
  browser compiler and checks that each example exists in both languages and is used by the guide
  (`site/src/<lang>/guide*.mango`).

## Adding a language feature

Go through the whole list; tests must cover each layer that changed.

1. Lexer, AST (`src/ast/`), parser; `src/walk.ts` if the AST has new children.
2. Checker: types, error messages.
3. Code generator; runtime helpers if needed.
4. Tests in `tests/` by area. DOM behaviour is tested with the small fake DOM in
   `tests/fake-dom.ts` (`mountWithDom`, `runWithDom`): extend it rather than adding jsdom.
5. `docs/spec.md` (and `docs/components.md` for markup and components), in both languages.
6. A guide section and an example on the site, in both languages.
7. Highlighting: the VS Code grammar in `editors/vscode/syntaxes/` with a case in
   `tests/vscode-grammar.test.ts`, and the site highlighter `site/src/highlight.mango`.
8. The playground (`site/src/sandbox.mango`) if the generated code needs something from the page.
9. `npm run check`; for site changes also `npm run site:build`.
