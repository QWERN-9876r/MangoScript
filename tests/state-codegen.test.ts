import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';

// The code generated for component state: update functions, live markup, `bind:`.

function js(source: string): string {
  const { code, diagnostics } = compile(source);
  expect(diagnostics).toEqual([]);
  return code.trimEnd();
}

/** The compiled code without the helpers at the top. */
function body(source: string): string {
  return js(source).replace(/^(function \$\$[\s\S]*?\n}\n\n)+/, '');
}

describe('code generation', () => {
  it('compiles the counter from the concept: one change, one update, written in place', () => {
    expect(
      js(`comp Counter(initialValue number) {
    state count = initialValue
    return <button onClick={count++}>Нажато {count} раз</button>
}

document.body.append(<Counter initialValue={0} />)`),
    ).toBe(
      `// <Counter>
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
  $$button3.append("Нажато ", $$text4, " раз");
  $$counter1 = $$button3;
}
document.body.append($$counter1);`,
    );
  });

  it('collects several updates into a function; bind: does not update its own element', () => {
    expect(
      js(`comp Greeting() {
    state name = ""
    return <label>
        <input bind:value={name} />
        <button onClick={name = ""}>×</button>
        Привет, {name}!
    </label>
}
document.body.append(<Greeting />)`),
    ).toBe(
      `// <Greeting>
let $$greeting1;
{
  let name = "";
  const $$label3 = document.createElement("label");
  const $$input4 = document.createElement("input");
  $$input4.value = name;
  $$input4.addEventListener("input", () => {
    name = $$input4.value;
    $$updateName2();
  });
  const $$button5 = document.createElement("button");
  $$button5.addEventListener("click", () => {
    name = "";
    $$updateName2();
  });
  $$button5.append("×");
  const $$text6 = document.createTextNode(name);
  $$label3.append($$input4, $$button5, "Привет, ", $$text6, "!");

  function $$updateName2() {
    if ($$input4.value !== name) $$input4.value = name;
    $$text6.data = name;
  }

  $$greeting1 = $$label3;
}
document.body.append($$greeting1);`,
    );
  });

  it('updates after changes in functions, conditions and returned values', () => {
    expect(
      js(`comp Stack() {
    state items = [1, 2]
    state log = ""

    func take() number {
        return items.pop() ?? 0
    }

    func pop() {
        if items.pop() == null {
            log = "empty"
            return
        }
    }

    return <div>
        <button onClick={pop()}>pop</button>
        <button onClick={console.log(take())}>take</button>
        <button onClick={setTimeout(() => items.push(9), 0)}>later</button>
        {items.length}
    </div>
}

document.body.append(<Stack />)`),
    ).toBe(
      `// <Stack>
let $$stack1;
{
  let items = [1, 2];
  let log = "";

  function take() {
    const $$0 = items.pop() ?? 0;
    $$updateItems2();
    return $$0;
  }

  function pop() {
    if (items.pop() == null) {
      $$updateItems2();
      log = "empty";
      return;
    }
    $$updateItems2();
  }

  const $$div4 = document.createElement("div");
  const $$button5 = document.createElement("button");
  $$button5.addEventListener("click", () => {
    pop();
  });
  $$button5.append("pop");
  const $$button6 = document.createElement("button");
  $$button6.addEventListener("click", () => {
    console.log(take());
  });
  $$button6.append("take");
  const $$button7 = document.createElement("button");
  $$button7.addEventListener("click", () => {
    setTimeout(() => {
      const $$0 = items.push(9);
      $$updateItems2();
      return $$0;
    }, 0);
  });
  $$button7.append("later");
  const $$text8 = document.createTextNode(items.length);
  $$div4.append($$button5, $$button6, $$button7, $$text8);

  function $$updateItems2() {
    if (!$$stack1) return;
    $$text8.data = items.length;
  }

  $$stack1 = $$div4;
}
document.body.append($$stack1);`,
    );
  });

  it('passes state to child components through setter functions', () => {
    expect(
      js(`comp Card(title string, children Content) {
    return <section><h2>{title}</h2>{children}</section>
}

comp Stepper(value number, onChange func(number)) {
    return <span>
        <button onClick={onChange(value - 1)}>-</button>
        {value}
        <button onClick={onChange(value + 1)}>+</button>
    </span>
}

comp App() {
    state count = 1
    return <Card title={\`Счёт: \${count}\`}>
        <Stepper value={count} onChange={count = event} />
        <p>{count * 2}</p>
    </Card>
}

let name = "Ann"
document.body.append(<App />, <input bind:value={name} />)`),
    ).toBe(
      `let name = "Ann";
// <App>
let $$app1;
{
  let count = 1;
  // <Card>
  const $$0 = \`Счёт: \${count}\`;
  const $$children3 = document.createDocumentFragment();
  // <Stepper>
  const $$1 = (event) => {
    count = event;
    $$updateCount2();
  };
  let $$stepper4;
  let $$setValue5;
  {
    let value = count;
    const onChange = $$1;
    const $$span7 = document.createElement("span");
    const $$button8 = document.createElement("button");
    $$button8.addEventListener("click", () => {
      onChange(value - 1);
    });
    $$button8.append("-");
    const $$text9 = document.createTextNode(value);
    const $$button10 = document.createElement("button");
    $$button10.addEventListener("click", () => {
      onChange(value + 1);
    });
    $$button10.append("+");
    $$span7.append($$button8, $$text9, $$button10);

    $$setValue5 = ($$value) => {
      value = $$value;
      $$text9.data = value;
    };

    $$stepper4 = $$span7;
  }
  const $$p11 = document.createElement("p");
  const $$text12 = document.createTextNode(count * 2);
  $$p11.append($$text12);
  $$children3.append($$stepper4, $$p11);
  let $$card13;
  let $$setTitle14;
  {
    let title = $$0;
    const children = $$children3;
    const $$section16 = document.createElement("section");
    const $$h217 = document.createElement("h2");
    const $$text18 = document.createTextNode(title);
    $$h217.append($$text18);
    $$section16.append($$h217, children);

    $$setTitle14 = ($$title) => {
      title = $$title;
      $$text18.data = title;
    };

    $$card13 = $$section16;
  }

  function $$updateCount2() {
    if (!$$app1) return;
    $$setValue5(count);
    $$text12.data = count * 2;
    $$setTitle14(\`Счёт: \${count}\`);
  }

  $$app1 = $$card13;
}
const $$input19 = document.createElement("input");
$$input19.value = name;
$$input19.addEventListener("input", () => {
  name = $$input19.value;
});
document.body.append($$app1, $$input19);`,
    );
  });

  it('replaces changing nodes with the $$content helper, which evaluates them again', () => {
    const code = js(`comp Tags() {
    state tags = ["mango"]
    return <ul onClick={tags.push("x")}>{tags.map(tag => <li>{tag}</li>)}</ul>
}
document.body.append(<Tags />)`);
    expect(code).toContain('function $$content(value) {');
    expect(code.slice(code.indexOf('// <Tags>'))).toBe(`// <Tags>
let $$tags1;
{
  let tags = ["mango"];
  const $$ul3 = document.createElement("ul");
  $$ul3.addEventListener("click", () => {
    tags.push("x");
    $$updateContent4();
  });
  const [$$content4, $$updateContent4] = $$content(() => tags.map((tag) => {
    const $$li5 = document.createElement("li");
    $$li5.append(tag);
    return $$li5;
  }));
  $$ul3.append($$content4);
  $$tags1 = $$ul3;
}
document.body.append($$tags1);`);
  });

  it('leaves components without state as they were', () => {
    expect(
      body(`comp Label(text string) {
    return <b>{text}</b>
}
document.body.append(<Label text="hi" />)`),
    ).toBe(`// <Label>
let $$label1;
{
  const text = "hi";
  $$label1 = document.createElement("b");
  $$label1.append(text);
}
document.body.append($$label1);`);
  });
});
