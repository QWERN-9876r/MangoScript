import * as monaco from 'monaco-editor/editor/editor.api';

// The colors of the editor are the variables of the page (site/ui/theme.module.css and
// site/src/highlight.module.css). Some are rgb() with transparency or color-mix(), which only an
// element resolves: a hidden probe takes each one as its color.

const THEME = 'rook';

/** The colors of the classes of tokens, see textmate.ts. */
const TOKENS: Record<string, string> = {
  kw: '--hl-kw',
  type: '--hl-type',
  fn: '--hl-fn',
  str: '--hl-str',
  num: '--hl-num',
  lit: '--hl-num',
  com: '--hl-com',
  tag: '--hl-tag',
  attr: '--hl-attr',
};

const byte = (value: number) => Math.round(value).toString(16).padStart(2, '0');

/** A computed `rgb(…)` as Monaco wants it, `#rrggbb`. */
function hex(color: string): string {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);

  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** Resolves CSS colors, variables included. */
function resolver(): { color: (css: string) => string; done: () => void } {
  const probe = document.createElement('span');

  probe.style.display = 'none';
  document.body.append(probe);

  return {
    color(css) {
      probe.style.color = css;

      return hex(getComputedStyle(probe).color);
    },
    done: () => probe.remove(),
  };
}

function defineTheme(): void {
  const { color, done } = resolver();
  const variable = (name: string) => color(`var(${name})`);
  // A computed color-mix() is not rgb(), so the transparency is added here.
  const mixed = (name: string, percent: number) => variable(name) + byte((percent / 100) * 255);

  monaco.editor.defineTheme(THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: variable('--rui-code-text') },
      ...Object.entries(TOKENS).map(([token, name]) => ({
        token,
        foreground: variable(name),
        ...(token === 'com' ? { fontStyle: 'italic' } : {}),
      })),
    ],
    colors: {
      'editor.background': variable('--rui-code-bg'),
      'editor.foreground': variable('--rui-code-text'),
      'editorCursor.foreground': variable('--rui-text'),
      'editor.selectionBackground': mixed('--rui-accent', 30),
      'editor.inactiveSelectionBackground': mixed('--rui-accent', 18),
      'editor.lineHighlightBackground': mixed('--rui-accent', 7),
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': mixed('--rui-muted', 60),
      'editorLineNumber.activeForeground': variable('--rui-muted'),
      'editorIndentGuide.background1': variable('--rui-line'),
      'editorError.foreground': variable('--rui-danger'),
      'editorWarning.foreground': variable('--rui-accent'),
      'editorWidget.background': variable('--rui-surface'),
      'editorWidget.border': variable('--rui-line-strong'),
      'editorSuggestWidget.background': variable('--rui-surface'),
      'editorSuggestWidget.border': variable('--rui-line-strong'),
      'editorSuggestWidget.selectedBackground': variable('--rui-accent-soft'),
      'editorHoverWidget.background': variable('--rui-surface'),
      'editorHoverWidget.border': variable('--rui-line-strong'),
      focusBorder: '#00000000',
    },
  });
  done();
}

/** Gives the editors the colors of the page. */
export function applyPageTheme(): void {
  defineTheme();
  monaco.editor.setTheme(THEME);
}
