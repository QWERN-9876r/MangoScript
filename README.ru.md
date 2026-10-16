# MangoScript

[English](README.md) · **Русский**

Язык с семантикой JavaScript, синтаксисом в духе Go, горутинами на настоящих потоках и статической
типизацией. Компилируется в читаемый JavaScript без рантайма (в планах — WebAssembly).

```go
async func square(jobs <-chan number, results chan<- number) {
    for n in jobs {
        results <- n * n
    }
}

const jobs = chan<number>(10)
const results = chan<number>()
go square(jobs, results)            // другой поток, одновременно с остальной программой
go square(jobs, results)

for let n = 1; n <= 4; n++ {
    jobs <- n
}
close(jobs)
for let i = 0; i < 4; i++ {
    console.log(<-results)
}
```

- **Горутины и каналы.** `go f(x)` запускает функцию горутиной, на другом процессоре, а каналы,
  `select`, `after`, `tick` и `cancel` работают как в Go; `go for i, v in pixels { ... }` делит
  массив между процессорами. Компилятор проверяет, что уходящее в другой поток можно туда
  скопировать.
- **Синтаксис Go.** `func`, тип после имени, несколько результатов, ошибки вторым значением,
  `defer`, один цикл `for`:

  ```go
  func divide(a, b number) (number, error) {
      if b == 0 {
          return 0, error("division by zero")
      }
      return a / b, null
  }
  ```

- **Статическая типизация с null-safety.** Значение типа `?User` нельзя использовать без проверки.
- **Внутри — JavaScript.** Те же значения, классы и модули, любые JS-библиотеки; разметка создаёт
  настоящие DOM-элементы, а компоненты исчезают при компиляции.

Руководство с примерами и песочницей: <https://qwern-9876r.github.io/MangoScript/ru/>.
Спецификация: [docs/spec.ru.md](docs/spec.ru.md), концепция компонентов:
[docs/components.ru.md](docs/components.ru.md), пример: [examples/hello.mango](examples/hello.mango).

## Установка

Нужен Node.js ≥ 24.

```sh
npm install --save-dev mangoscript
npx mango build app.mango                # app.js рядом с исходником
npx mango build src --out-dir dist       # все модули папки
npx mango run app.mango                  # скомпилировать и запустить
```

Из кода компилятор подключается как `import { compile } from 'mangoscript'`. Ещё в пакете есть
плагин для [Vite](#vite) — `mangoscript/vite` — и `mangoscript/browser`: компилятор без
компилятора TypeScript, для работы в браузере, как в песочнице сайта; импорты там не проверяются
по типам.

## Разработка

Node.js ≥ 24 (`nvm use`). Компилятор написан на TypeScript, Node запускает `.ts`-файлы напрямую,
поэтому отдельная сборка для разработки не нужна: команды ниже запускают компилятор из `src/`.
`dist/` собирается только для npm-пакета.

`npm install` ставит и pre-commit хук, который форматирует застейдженные файлы: ESLint добавляет
пустые строки между операторами, которые Prettier сохраняет, но сам не добавляет, затем
форматирует Prettier. Форматируется только застейдженная версия, так что незастейдженные правки
в коммит не попадают.

## Команды

| Команда                              | Что делает                                                  |
| ------------------------------------ | ----------------------------------------------------------- |
| `npm run mango -- build file.mango`  | Скомпилировать в `file.js` вместе с импортируемыми `.mango` |
| `npm run mango -- run file.mango`    | Скомпилировать и запустить                                  |
| `npm run mango -- tokens file.mango` | Показать токены лексера                                     |
| `npm run mango -- ast file.mango`    | Показать синтаксическое дерево                              |
| `npm test` / `npm run test:watch`    | Тесты (Vitest)                                              |
| `npm run typecheck`                  | Проверка типов                                              |
| `npm run lint` / `npm run format`    | ESLint / Prettier с пустыми строками от ESLint              |
| `npm run check`                      | Всё сразу — типы, линт, формат, тесты                       |
| `npm run build`                      | Собрать npm-пакет в `dist/`                                 |
| `npm run vscode:install`             | Собрать и установить расширение для VS Code                 |

Опции `build`: `--out-dir dir` — писать `.js` в отдельную папку, `--stdout` — вывести JS одного
файла в консоль, `--no-check` — без проверки типов. `--markup` и `--no-markup` включают или
выключают разметку и компоненты для всех файлов (и в `run`); по умолчанию они выключены, а пакет
включает их в своём `package.json`: `"mangoscript": { "markup": true }`.

## Релизы

Релиз — это новая версия в `package.json` в `main`: `npm version minor --no-git-tag-version` (или
`patch`) меняет её, а пуш в `main` выпускает релиз. Workflow
[.github/workflows/publish.yml](.github/workflows/publish.yml) видит, что такой версии в npm ещё
нет, запускает `npm run check`, собирает `dist/`, публикует пакет в npm и ставит на коммит тег
`v0.2.0`. Пуш без новой версии ничего не публикует.

## VS Code

В [editors/vscode/](editors/vscode/) лежит расширение для файлов `.mango`: подсветка кода, типов и
разметки, ошибки прямо при наборе и автодополнение имён, членов, типов, тегов и атрибутов — от
языкового сервера с компилятором. `npm run vscode:install` собирает его и устанавливает через
`code`; подробности — в [editors/vscode/README.ru.md](editors/vscode/README.ru.md).

## Сайт с документацией

В [site/](site/) лежит руководство по MangoScript на английском (`index.html`) и русском
(`ru/index.html`). И страница, и сервер написаны на MangoScript, а компилятор работает прямо в
браузере: у каждого примера есть вкладка с JavaScript, который из него получается, и кнопка
запуска, а внизу страницы — песочница.

- [site/src/en/](site/src/en/) и [site/src/ru/](site/src/ru/) — текст разделов на каждом языке,
  перечисленных в `guide.mango`; разделы о разметке и компонентах — в `guide-components.mango`;
- [site/examples/](site/examples/) и [site/examples/ru/](site/examples/ru/) — примеры кода; тесты
  проверяют, что все они компилируются и что у каждого есть перевод;
- [site/src/i18n.mango](site/src/i18n.mango) — язык страницы и тексты вокруг руководства;
- [site/src/example.mango](site/src/example.mango) и
  [site/src/playground.mango](site/src/playground.mango) — пример с вкладками и песочница,
  компоненты со `state`, `bind:` и `{if}` / `{for}`;
- [site/src/highlight.mango](site/src/highlight.mango) — подсветка кода лексером компилятора;
- [site/src/editor/](site/src/editor/) — редактор песочницы, тот же, что в VS Code (Monaco), с
  грамматикой расширения VS Code, ошибками компилятора прямо в коде и его автодополнением;
  TypeScript для браузера, проверяется по [site/tsconfig.json](site/tsconfig.json);
- [site/server.mango](site/server.mango) — статический сервер на `node:http` с логом через `defer`.

Сайт собирает Vite ([vite.config.ts](vite.config.ts)): `.mango`-модули компилирует плагин
[src/vite.ts](src/vite.ts) с проверкой типов, компилятор для песочницы берётся прямо из
[src/browser.ts](src/browser.ts), а код примеров попадает в бандл из модулей
`virtual:examples/en` и `virtual:examples/ru`. Компилятор вынесен в отдельный чанк, его загружает
[site/src/compiler.ts](site/src/compiler.ts) при первом запуске, при открытии вкладки JavaScript и
когда песочница появляется на экране: самой странице нужен только лексер для подсветки. Тогда же
загружается редактор песочницы, около 3,5 МБ; до этого и на сенсорных экранах у песочницы свой
textarea.

```sh
npm run site:dev    # сервер разработки Vite: изменения видны сразу
npm run site        # собирает сайт в site/dist и запускает site/server.mango на http://localhost:3000
```

## Vite

Плагин `mangoscript/vite` ([src/vite.ts](src/vite.ts)) подключает MangoScript к любому проекту на
Vite:

```ts
import { defineConfig } from 'vite';
import { mango } from 'mangoscript/vite';

export default defineConfig({ plugins: [mango()] });
```

После этого `.mango`-файлы можно импортировать из JS, TS и других `.mango`-модулей. Ошибки типов
останавливают сборку, а в режиме разработки показываются поверх страницы. Разметка и компоненты по
умолчанию выключены, поэтому `.mango`-модули подходят приложению на React, Svelte или Vue как
есть; включить их можно через `"mangoscript": { "markup": true }` в `package.json` или
`mango({ markup: true })`.

## Соглашения

- Импорты пишутся с расширением `.ts` (`import { x } from './lexer.ts'`).
- Только «стираемый» синтаксис TS: вместо `enum` — union-типы строк или `as const`-объекты.
- Тексты для людей — сначала на английском (README, документация, сайт, примеры, комментарии);
  русские версии лежат рядом: `README.ru.md`, `docs/*.ru.md`, `site/examples/ru/`.
