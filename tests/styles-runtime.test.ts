import { describe, expect, it } from 'vitest';
import { mountWithDom } from './fake-dom.ts';

// Styles of components at runtime, with the fake DOM: the CSS is added to <head> once, the
// elements get the class of the style, and the values from code are CSS variables that follow
// the state.

const meter = `comp Meter(color string) {
    state percent = 10
    style {
        .meter { height: 8px }
        .fill { width: {percent}%; background: {color} }
    }
    return <div class="meter">
        <div class="fill" />
        <button onClick={percent += 40}>+</button>
    </div>
}
document.body.append(<Meter color="green" />, <Meter color="orange" />)
`;

describe('component styles', () => {
  it('adds the CSS to <head> once, however many instances there are', () => {
    const { head, body } = mountWithDom(meter);
    const [style] = head.childNodes;

    expect(head.childNodes).toHaveLength(1);
    expect(style!.tagName).toBe('style');
    expect(String(style!.id)).toMatch(/^rook-meter-\w+$/);
    expect(String(style!.textContent)).toContain(`.fill.${String(style!.id)} {`);
    expect(String(body.find('div').className)).toBe(`meter ${String(style!.id)}`);
    expect(String(body.find('button').className)).toBe(String(style!.id));
  });

  it('sets the values from code on each instance and updates them', () => {
    const { body } = mountWithDom(meter);
    const [first, second] = body.childNodes;
    const variable = (node: typeof first, n: number) =>
      Object.entries(node!.style).find(([name]) => name.endsWith(`-${n}`))?.[1];

    expect(variable(first, 0)).toBe('10%');
    expect(variable(first, 1)).toBe('green');
    expect(variable(second, 1)).toBe('orange');

    first!.find('button').click();
    expect(variable(first, 0)).toBe('50%');
    expect(variable(second, 0)).toBe('10%');
  });

  it('gives the markup of a decorator the class of its style', () => {
    const { head, body } = mountWithDom(`dec framed(width number) {
    style {
        .frame { border-width: {width}px }
    }
    return (content Element) => <div class="frame">{content}</div>
}
@framed(3)
comp Card() {
    style {
        p { margin: 0 }
    }
    return <p>card</p>
}
document.body.append(<Card />)
`);
    const ids = head.childNodes.map((style) => String(style.id));
    const frame = body.find('div');

    expect(ids).toHaveLength(2);
    expect(String(frame.className)).toMatch(/^frame rook-framed-\w+$/);
    expect(String(frame.find('p').className)).toMatch(/^rook-card-\w+$/);
    expect(Object.values(frame.style)).toContain('3px');
  });

  it('puts the CSS of the module into the shadow root of a web component', () => {
    const { body } = mountWithDom(`@html-tag("app-badge")
comp Badge(text string = "new") {
    style {
        span { padding: 2px }
    }
    return <span>{text}</span>
}
document.body.append(document.createElement("app-badge"))
`);
    const root = body.find('app-badge').shadowRoot!;

    expect(root.childNodes[0]!.tagName).toBe('style');
    expect(String(root.childNodes[0]!.textContent)).toMatch(/^span\.rook-badge-\w+ \{/);
    expect(String(root.find('span').className)).toMatch(/^rook-badge-\w+$/);
  });
});
