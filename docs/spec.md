# MangoScript — черновик спецификации v0

> Статус: черновик, всё можно менять. Нерешённые вопросы собраны в разделе «Открытые вопросы».

MangoScript — язык с семантикой JavaScript, синтаксисом в духе Go и статической типизацией.
Компилируется в читаемый JavaScript (ES-модули), типы при компиляции стираются.

## Принципы

1. **Семантика JS.** Те же значения, объекты, классы, замыкания, модули и стандартная библиотека
   (`console`, `Math`, `JSON`, методы массивов и строк).
2. **Синтаксис Go там, где он удобнее:** `func`, тип после имени, множественный возврат, `defer`,
   нулевые значения, условия без скобок, единственный цикл `for`, `switch` без `break`, без точек
   с запятой.
3. **Статическая типизация с null-safety.** Ошибки типов находит компилятор; `null` можно
   присвоить только типу, который это явно разрешает. В JS-коде типов нет.
4. **Совместимость с JS.** Из MangoScript можно импортировать любой JS-модуль, а скомпилированный
   модуль можно использовать из JS.

## 1. Лексика

### Комментарии

`// до конца строки` и `/* блок */`.

### Точки с запятой

Их пишут только чтобы разделить несколько операторов в одной строке. В остальных случаях лексер
ставит их сам по правилу Go: в конце строки, если последний токен —

- идентификатор или литерал (число, строка, `true`, `false`, `null`);
- `this`, `return`, `break` или `continue`;
- `++`, `--`, `)`, `]`, `}`.

Отсюда, как и в Go:

- открывающая `{` стоит на той же строке, что `if`, `for`, `func`, `class`;
- при переносе длинного выражения бинарный оператор оставляют в конце строки;
- перед `}` точка с запятой не нужна: `if ok { return x }`.

**Отличия от Go:** точка с запятой не ставится, если следующая строка начинается

- с `.` или `?.` — поэтому работают привычные цепочки вызовов;
- с закрывающей скобки `)`, `]` или `}` — поэтому запятая после последнего элемента
  многострочного списка не обязательна.

```go
const names = users
    .filter(u => u.active)
    .map(u => u.name)

const point = {
    x: 1,
    y: 2
}
```

### Литералы

- Числа как в JS: `42`, `3.14`, `1e3`, `0xff`, `1_000_000`.
- Строки: `"..."`, `'...'` и шаблонные `` `Hello, ${name}` ``.
- `true`, `false`, `null`.
- Массивы `[1, 2, ...rest]` и объекты `{ name: "Ann", age, "content-type": t, ...defaults }`
  (сокращённая запись `age` и spread — как в JS).

### Ключевые слова

```
func  return  let  const  type  interface  class  extends  new  this  super
if  else  for  in  break  continue  switch  case  default  defer
try  catch  finally  throw  import  export
null  true  false  typeof  instanceof
```

Внутри объявления класса ключевыми словами считаются ещё `static`, `private`, `protected`,
`public` и `implements`, а в `import` и `export` — `from`. В остальных местах это обычные имена.
Зарезервированы на будущее: `map`, `async`, `await`.

После `.` и в ключах объектов ключевые слова можно использовать как обычные имена:
`xs.map(f)`, `event.type`, `{ default: 1 }`.

Предопределённые идентификаторы (не ключевые слова, их можно перекрыть): типы `number`, `string`,
`bool`, `any`, `error` и функция `error()`.

Имена, которые начинаются с `$$`, зарезервированы за сгенерированным кодом (`$$defer`, `$$0`).
Имена, допустимые в MangoScript, но запрещённые в JS (`delete`, `static`, `function`…), в
выходном коде получают суффикс `$`: `delete` → `delete$`.

## 2. Переменные

```go
let count = 0              // тип выводится: number
let name string = "Ann"
let total number           // нулевое значение: 0
const PI = 3.14
let a, b = 1, 2
```

```js
let count = 0;
let name = "Ann";
let total = 0;
const PI = 3.14;
let a = 1, b = 2;
```

`const` переприсвоить нельзя, это проверяет компилятор.

Множественное присваивание, как в Go:

```go
a, b = b, a                // → [a, b] = [b, a];
```

### Нулевые значения

Переменная или поле класса без начального значения получает нулевое значение своего типа,
как в Go:

| Тип                        | Нулевое значение                  |
| -------------------------- | --------------------------------- |
| `number`                   | `0`                               |
| `string`                   | `""`                              |
| `bool`                     | `false`                           |
| `[]T`                      | `[]` (каждый раз новый массив)    |
| `?T`, `error`, `any`       | `null`                            |
| классы, интерфейсы, `func` | нет — значение нужно указать явно |

```go
let u User                 // ошибка: у User нет нулевого значения
let u ?User                // можно: u == null
```

## 3. Типы

| MangoScript    | Значения                                   | В JS                |
| -------------- | ------------------------------------------ | ------------------- |
| `number`       | числа                                      | `number`            |
| `string`       | строки                                     | `string`            |
| `bool`         | `true`, `false`                            | `boolean`           |
| `any`          | что угодно, проверки отключены             | —                   |
| `error`        | ошибка или `null`                          | `Error` или `null`  |
| `[]T`          | массив                                     | `Array`             |
| `?T`           | значение типа `T` или `null`               | значение или `null` |
| `func(A, B) R` | функция                                    | функция             |
| `{ x number }` | объект с такими полями                     | объект              |
| имя класса     | экземпляр класса                           | экземпляр класса    |
| имя интерфейса | любое значение с нужными полями и методами | —                   |

Тип пишется после имени без двоеточия: `x number`, `xs []string`, `cb func(number) bool`,
`user ?User`.

Типизация **структурная**, как в TypeScript: значение подходит под тип, если у него есть все нужные
поля и методы нужных типов.

### Объявление типов

```go
type ID string
type Handler func(string) bool
type Pair { first, second number }
```

`type` даёт типу другое имя: `ID` и `string` взаимозаменяемы (в Go это были бы разные типы).
Для формы объектов обычно используют интерфейсы (раздел 8).

### null и null-safety

«Пустое» значение в языке одно — `null`; `undefined` в MangoScript нет. Обычное `==`
компилируется в `===`, но сравнение с `null` остаётся нестрогим: `x == null` → `x == null`.
Поэтому оно ловит и `null`, и `undefined`, пришедший из JS-кода.

`null` можно присвоить только типам `?T`, `error` и `any`. Чтобы обратиться к полю или методу
значения типа `?T`, тип нужно сначала сузить:

```go
func findUser(id number) ?User { ... }

const u = findUser(1)
console.log(u.name)                  // ошибка: u может быть null
console.log(u?.name)                 // можно: тип ?string
console.log(u?.name ?? "anonymous")  // можно: тип string

if u != null {
    console.log(u.name)              // здесь у u тип User
}

if u == null {
    return
}
console.log(u.name)                  // и здесь: при null функция уже вышла
```

- Сужение работает для локальных переменных и параметров. Значение поля (`this.user`) сначала
  кладут в `const`.
- `error` всегда допускает `null`, писать `?error` не нужно.
- `xs[i]` имеет тип `T`, а не `?T`: выход за границы массива компилятор не ловит (так же по
  умолчанию в TypeScript).
- Значения типа `any`, в том числе всё, что импортировано из JS-модулей, не проверяются.

## 4. Функции

```go
func add(a, b number) number {
    return a + b
}

func greet(name string) {          // без типа результата — ничего не возвращает
    console.log(`Hello, ${name}`)
}
```

```js
function add(a, b) {
  return a + b;
}

function greet(name) {
  console.log(`Hello, ${name}`);
}
```

Соседние параметры одного типа можно сгруппировать: `a, b number` — то же, что
`a number, b number`.

Объектный тип результата берётся в скобки, иначе его `{` не отличить от тела функции:
`func origin() ({ x, y number }) { ... }`.

### Множественный возврат

```go
func divmod(a, b number) (number, number) {
    return Math.floor(a / b), a % b
}

const q, r = divmod(17, 5)
const _, rest = divmod(17, 5)      // _ пропускает значение
```

```js
function divmod(a, b) {
  return [Math.floor(a / b), a % b];
}

const [q, r] = divmod(17, 5);
const [, rest] = divmod(17, 5);
```

Правила, как в Go:

- несколько значений можно только вернуть через `return` и сразу разложить по переменным
  в `let`/`const` или в присваивании;
- число переменных должно совпадать с числом значений;
- `divmod(17, 5) + 1` — ошибка компиляции.

### Анонимные функции

```go
const square = func(x number) number { return x * x }
const sum = (a, b number) => a + b
const doubled = nums.map(x => x * 2)      // тип x берётся из контекста
```

Стрелочные функции — как в JS, только с типами в стиле Go. Если тип параметра нельзя вывести из
контекста, его нужно указать.

`func`-литерал тоже компилируется в стрелочную функцию, поэтому `this` внутри него — это `this`
окружающего метода, а не новый, как у `function` в JS.

### defer

`defer` откладывает вызов до выхода из функции: при `return`, в конце тела или при исключении.

```go
func readConfig(path string) (string, error) {
    const fd = fs.openSync(path, "r")
    defer fs.closeSync(fd)

    const text = fs.readFileSync(fd, "utf8")
    if text == "" {
        return "", error("empty config")
    }
    return text, null
}
```

```js
function readConfig(path) {
  const fd = fs.openSync(path, "r");
  try {
    const text = fs.readFileSync(fd, "utf8");
    if (text === "") {
      return ["", new Error("empty config")];
    }
    return [text, null];
  } finally {
    fs.closeSync(fd);
  }
}
```

Правила, как в Go:

- функция и её аргументы вычисляются в момент `defer`, а сам вызов происходит при выходе;
- несколько отложенных вызовов выполняются в обратном порядке;
- если отложенный вызов бросает исключение, остальные всё равно выполняются;
- `defer` относится ко всей функции, а не к блоку: `defer` в цикле добавляет вызов на каждой
  итерации, и все они выполнятся при выходе из функции;
- `defer` бывает только внутри функций и методов;
- внутри `defer { ... }` нельзя писать `return`, а `break` и `continue` — только во вложенных
  в него циклах: отложенный код не может изменить то, как функция завершилась.

```go
func countdown() {
    for let i = 0; i < 3; i++ {
        defer console.log(i)
    }
}
// countdown() печатает 2, 1, 0
```

Для нескольких действий есть блочная форма, её содержимое выполняется целиком при выходе:

```go
defer {
    conn.close()
    console.log("connection closed")
}
```

Если все `defer` стоят на верхнем уровне тела функции, компилятор выдаёт вложенные
`try/finally`, как в примере выше. Если `defer` стоит внутри `if` или цикла, отложенные вызовы
собираются в стек и выполняются в `finally`.

## 5. Условия и циклы

### if

```go
if x > 0 {
    console.log("positive")
} else if x < 0 {
    console.log("negative")
} else {
    console.log("zero")
}
```

Скобки вокруг условия не нужны, фигурные обязательны. Условие должно иметь тип `bool`: в отличие
от JS, никаких truthy/falsy. `if count {` — ошибка, пишем `if count > 0 {`, а вместо `if user {`
пишем `if user != null {`.

Объектный литерал в заголовке `if`, `for` или `switch` берётся в скобки, иначе его `{` спутать с
началом блока (то же правило в Go).

### for — единственный цикл

| MangoScript                     | JS                                          |
| ------------------------------- | ------------------------------------------- |
| `for let i = 0; i < n; i++ { }` | `for (let i = 0; i < n; i++) { }`           |
| `for x in items { }`            | `for (const x of items) { }`                |
| `for i, x in items { }`         | `for (const [i, x] of items.entries()) { }` |
| `for cond { }`                  | `while (cond) { }`                          |
| `for { }`                       | `while (true) { }`                          |

`for x in items` перебирает **значения**, как `for...of` в JS или `for x in` в Python и Rust, а
не ключи, как `for...in` в JS. В Go `for i := range xs` с одной переменной даёт индекс; здесь одна
переменная получает значение, а две — индекс и значение.

`break` и `continue` работают как обычно.

### switch

```go
switch cmd {
case "start", "run":
    start()
case "stop":
    stop()
default:
    console.log("unknown command")
}
```

```js
switch (cmd) {
  case "start":
  case "run":
    start();
    break;
  case "stop":
    stop();
    break;
  default:
    console.log("unknown command");
}
```

Каждый `case` неявно заканчивается `break`, несколько значений перечисляются через запятую.

`switch` без выражения заменяет длинную цепочку `if`:

```go
switch {
case score >= 90:
    grade = "A"
case score >= 75:
    grade = "B"
default:
    grade = "C"
}
```

```js
if (score >= 90) {
  grade = "A";
} else if (score >= 75) {
  grade = "B";
} else {
  grade = "C";
}
```

## 6. Ошибки

Ожидаемые ошибки (некорректный ввод, файл не найден) возвращаются последним значением типа
`error`:

```go
func parsePort(s string) (number, error) {
    const n = Number(s)
    if Number.isNaN(n) || n < 1 || n > 65535 {
        return 0, error(`invalid port: ${s}`)
    }
    return n, null
}

const port, err = parsePort(input)
if err != null {
    console.error(err.message)       // внутри if у err тип Error, а не null
}
```

```js
function parsePort(s) {
  const n = Number(s);
  if (Number.isNaN(n) || n < 1 || n > 65535) {
    return [0, new Error(`invalid port: ${s}`)];
  }
  return [n, null];
}

const [port, err] = parsePort(input);
if (err != null) {
  console.error(err.message);
}
```

`error(msg)` создаёт `new Error(msg)`.

Исключения остаются для JS-кода, который бросает, и для действительно аварийных ситуаций:

```go
let config any
try {
    config = JSON.parse(text)
} catch e {
    console.error("bad config:", e)
} finally {
    console.log("done")
}

throw error("unreachable")
```

`catch` записывается без скобок, `e` имеет тип `any`.

## 7. Классы

Классы как в JS и TypeScript, типы — в стиле Go. Методы объявляются без `func`, как методы
в JS-классах.

```go
class User {
    name string
    private age number             // нулевое значение: 0
    tags []string                  // нулевое значение: []
    static count = 0

    constructor(name string, age number) {
        this.name = name
        this.age = age
        User.count++
    }

    greet() string {
        return `Hi, I'm ${this.name}`
    }

    isAdult() bool {
        return this.age >= 18
    }
}

class Admin extends User {
    protected level number

    constructor(name string, age, level number) {
        super(name, age)
        this.level = level
    }

    greet() string {
        return `${super.greet()} (admin)`
    }
}

const ann = new User("Ann", 30)
```

```js
class User {
  name = "";
  age = 0;
  tags = [];
  static count = 0;

  constructor(name, age) {
    this.name = name;
    this.age = age;
    User.count++;
  }

  greet() {
    return `Hi, I'm ${this.name}`;
  }

  isAdult() {
    return this.age >= 18;
  }
}
```

- `private`, `protected` и `public` (по умолчанию) проверяются только компилятором, как в
  TypeScript. В JS они не попадают, поэтому из JS-кода поля доступны.
- Видимость задаётся модификаторами, а не регистром первой буквы, как в Go.
- К полям внутри методов обращаются через `this`, как в JS.
- Методы могут возвращать несколько значений.
- Поле без значения получает нулевое значение своего типа. Если у типа его нет (класс, интерфейс,
  функция), поле нужно присвоить в конструкторе.

## 8. Интерфейсы

Интерфейс описывает форму значения — поля и методы. Как и в TS, он существует только во время
компиляции.

```go
interface Shape {
    name string
    area() number
}

interface Point {
    x, y number
    label ?string                  // необязательное поле: можно не указывать
}

class Circle implements Shape {
    name = "circle"
    r number

    constructor(r number) {
        this.r = r
    }

    area() number {
        return Math.PI * this.r ** 2
    }
}

func describe(s Shape) string {
    return `${s.name}: ${s.area()}`
}

describe(new Circle(2))               // класс подходит под Shape
const p Point = { x: 1, y: 2 }        // объектный литерал подходит под Point
```

`implements` необязателен: класс подходит под интерфейс, если у него есть нужные поля и методы.
`implements` просто просит компилятор проверить это в месте объявления класса.

## 9. Модули

```go
import { readFileSync, writeFileSync as write } from "node:fs"
import * as path from "node:path"
import express from "express"
import "./setup.mango"

export func greet(name string) string {
    return `Hello, ${name}`
}
export const VERSION = "0.1.0"
export class User { ... }
export interface Point {
    x, y number
}
```

Импорты и экспорты переходят в ES-модули один к одному; `export interface` и `export type` при
компиляции исчезают. Импорты из JS-модулей в v0 имеют тип `any`. Позже типы можно будет брать из
`.d.ts`.

- Имя, которое используется только как тип (например, импортированный интерфейс), из `import`
  убирается: в рантайме такого значения нет.
- `mango build main.mango` пишет `main.js` рядом с исходником и так же компилирует все
  `.mango`-файлы, которые он импортирует. В импортах `.mango` заменяется на `.js`:
  `"./geom.mango"` → `"./geom.js"`. `mango build src/` собирает все `.mango`-файлы папки, а
  `--out-dir build/` складывает `.js` в отдельную папку с той же структурой. Если в каком-то
  файле есть ошибки, не пишется ни один файл.
- `mango run` компилирует импортируемые `.mango`-файлы на лету.

## 10. Операторы: отличия от JS

| MangoScript       | JS          | Примечание                                            |
| ----------------- | ----------- | ----------------------------------------------------- |
| `a == b`          | `a === b`   | нестрогого сравнения в языке нет                      |
| `a != b`          | `a !== b`   |                                                       |
| `x == null`       | `x == null` | остаётся нестрогим: ловит и `null`, и `undefined`     |
| `a = b`, `a += b` | то же       | только как оператор: `f(a = 1)`, `a = b = c` — ошибка |
| `i++`, `i--`      | то же       | только как оператор: `a = i++` — ошибка; `++i` нет    |
| `&&`, `\|\|`, `!` | то же       | только для `bool`; значение по умолчанию — через `??` |
| `a + b`           | то же       | числа или строки; `"a" + 1` — ошибка, нужен шаблон    |

Остальное как в JS: арифметика, сравнения, битовые операции, `**`, `??`, `?.`, `? :`, `typeof`,
`instanceof`, `new`, spread `...`, индексация `xs[i]`.

В языке нет: `var`, `function`, `===`, `while`, `do...while`, `for...in`, `with` и оператора
запятой.

Отдельным оператором может быть только вызов функции или `new`, как в Go: строка `a + b` или
`user.name` сама по себе — ошибка. Так ловятся опечатки и перенос перед бинарным оператором:

```go
const total = price
    + tax              // ошибка: после price уже стоит ;, а "+ tax" ничего не делает
```

## 11. Проверка типов

Компилятор проверяет типы до генерации JS; программа с ошибками типов не компилируется
(`mango build --no-check` пропускает проверку).

```
hello.mango:4:17: error: cannot use ?User as User: it may be null, check it first
hello.mango:7:13: error: "u" may be null: check it with "if u != null" or use "?."
hello.mango:9:11: error: cannot add string and number: use a template string, e.g. `${a}${b}`
```

### Что проверяется

- Типы значений в объявлениях, присваиваниях, аргументах и `return`; число аргументов и
  возвращаемых значений; `missing return`, если функция с результатом может дойти до конца тела.
- Null-safety: обращение к полям и методам `?T`, передача `?T` туда, где ждут `T`.
- Условия `if`/`for`/`?:` и операнды `&&`, `||`, `!` — только `bool`.
- Операторы: `+` для двух чисел или двух строк, арифметика только для чисел, `==` только для
  сравнимых типов.
- Имена: неизвестные переменные и типы, присваивание константам и переменным цикла, `_` как
  значение.
- Классы: видимость `private`/`protected`, аргументы конструктора, вызов `super(...)` в
  конструкторе наследника, совместимость переопределённых методов, `implements`, поля без нулевого
  значения, которым не присвоено значение.
- Объектные литералы: недостающие поля, лишние поля (вероятная опечатка), типы полей.

### Сужение типов

Тип локальной переменной или параметра сужается с `?T` до `T`:

- внутри `if x != null { ... }` и в ветках `?:`;
- после `if x == null { return }` (а также `throw`, `break`, `continue`);
- в правой части `x != null && x.ok` и `x == null || x.ok`;
- в теле цикла `for x != null { ... }`;
- после присваивания значения, которое не может быть `null`.

Присваивание переменной сбрасывает сужение. В цикле не сужаются переменные, которые в нём
меняются. В замыкании сужение сохраняется только для констант и переменных, которые нигде не
переприсваиваются.

### Вывод типов

- `let x = value` получает тип значения; `null` и `[]` без объявленного типа — ошибка.
- Параметры стрелочной функции берут типы из контекста: `xs.map(x => x * 2)`,
  `apply(n => n > 0)`. Результат стрелочной функции выводится из тела.
- Тип элементов массива — общий тип всех элементов: `[1, null]` — это `[]?number`.

### Встроенные типы JS

Типизированы `console`, `Math`, `JSON`, `Number`, `String`, `Boolean`, `parseInt`,
`parseFloat`, `setTimeout`/`setInterval`, `Error`, методы строк, чисел и массивов (`map`,
`filter`, `find`, `reduce`, `push`… — `find`, `pop` и `at` возвращают `?T`). Остальные глобальные
объекты JS (`Object`, `Date`, `Map`, `Promise`, `fetch`, `process`…) и всё, что импортировано из
JS-модулей, имеют тип `any`. Параметры колбэков, переданных в `any`-функции, тоже `any`.

Типы из импортированных `.mango`-модулей проверяются: компилятор читает эти модули сам.

## 12. Пример

[examples/hello.mango](../examples/hello.mango)

## 13. Не входит в v0

- **`async func` и `await`.**
- **`map[K]V`**, компилируется в `Map`: `m[k]` → `m.get(k)`, `m[k] = v` → `m.set(k, v)`.
- **Дженерики** в синтаксисе Go: `func first[T any](xs []T) T`.
- **Классы:** геттеры и сеттеры, `readonly`, абстрактные классы, параметры-свойства конструктора
  (`constructor(private name string)`).
- **Сужение типов** через `instanceof` и `typeof`.
- **`if` с инициализацией:** `if const v, err = f(); err != null { }`.
- **Метки** для `break`/`continue`.
- **Литералы регулярных выражений** `/.../g`. Пока — `new RegExp("...", "g")`.
- **Типы JS-библиотек** из `.d.ts`.
- **Source maps.**
- **WASM-бэкенд** для подмножества языка (числа, массивы, классы).

## Открытые вопросы

1. **Функции, которые возвращают объект и ошибку.** У класса нет нулевого значения, поэтому
   функция, которая может вернуть ошибку, должна вернуть `(?User, error)`. Вызывающему коду тогда
   нужны две проверки:

   ```go
   const user, err = loadUser(id)
   if err != null {
       return
   }
   if user != null {                 // вторая проверка — только ради типа
       console.log(user.name)
   }
   ```

   Предложение: разрешить сигнатуру `(User, error)` с `return null, err` и считать, что после
   проверки `err != null` значение уже не `null`. В рантайме ничего не меняется, это правило только
   для проверки типов.

## Порядок реализации

1. ~~Лексер с автоматической расстановкой `;`.~~
2. ~~Парсер → AST.~~
3. ~~Генерация JS.~~
4. ~~Проверка типов.~~
5. Возможности из раздела «Не входит в v0».
