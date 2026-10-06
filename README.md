# MangoScript

Язык с семантикой JavaScript, синтаксисом в духе Go и статической типизацией. Компилируется в
JavaScript (в планах — WebAssembly).

```go
func divide(a, b number) (number, error) {
    if b == 0 {
        return 0, error("division by zero")
    }
    return a / b, null
}

const q, err = divide(10, 4)
```

Спецификация: [docs/spec.md](docs/spec.md), пример: [examples/hello.mango](examples/hello.mango).

## Требования

Node.js ≥ 24 (`nvm use`). Компилятор написан на TypeScript, Node запускает `.ts`-файлы напрямую,
поэтому отдельная сборка для разработки не нужна.

## Команды

| Команда                              | Что делает                                                  |
| ------------------------------------ | ----------------------------------------------------------- |
| `npm run mango -- build file.mango`  | Скомпилировать в `file.js` вместе с импортируемыми `.mango` |
| `npm run mango -- run file.mango`    | Скомпилировать и запустить                                  |
| `npm run mango -- tokens file.mango` | Показать токены лексера                                     |
| `npm run mango -- ast file.mango`    | Показать синтаксическое дерево                              |
| `npm test` / `npm run test:watch`    | Тесты (Vitest)                                              |
| `npm run typecheck`                  | Проверка типов                                              |
| `npm run lint` / `npm run format`    | ESLint / Prettier                                           |
| `npm run check`                      | Всё сразу — типы, линт, формат, тесты                       |
| `npm run build`                      | Сборка в `dist/` (бинарь `mango`)                           |
| `npm run vscode:install`             | Собрать и установить расширение для VS Code                 |

Опции `build`: `--out-dir dir` — писать `.js` в отдельную папку, `--stdout` — вывести JS одного
файла в консоль, `--no-check` — без проверки типов.

## Подсветка в VS Code

В [editors/vscode/](editors/vscode/) лежит расширение с подсветкой синтаксиса `.mango`: код, типы
и разметка. `npm run vscode:install` собирает его и устанавливает через `code`; подробности — в
[editors/vscode/README.md](editors/vscode/README.md).

## Тестовый сайт

В [site/](site/) лежит список задач, где и страница, и сервер написаны на MangoScript:

- [site/src/todos.mango](site/src/todos.mango) — модель: интерфейс, класс, `?Todo` из `find`,
  ошибки вторым возвращаемым значением;
- [site/src/storage.mango](site/src/storage.mango) — сохранение в `localStorage`;
- [site/src/app.mango](site/src/app.mango) — работа с DOM; строка списка — компонент `TodoItem` с
  разметкой;
- [site/server.mango](site/server.mango) — статический сервер на `node:http` с логом через `defer`.

```sh
npm run site    # собирает site/src в site/dist и запускает сервер на http://localhost:3000
```

## Соглашения

- Импорты пишутся с расширением `.ts` (`import { x } from './lexer.ts'`).
- Только «стираемый» синтаксис TS: вместо `enum` — union-типы строк или `as const`-объекты.
