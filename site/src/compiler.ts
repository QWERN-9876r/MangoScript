// The compiler is most of the page's code, and the guide is read without it, so sandbox.mango loads
// it on first use and Vite puts it into a chunk of its own. The loading is here because MangoScript
// has no import() yet. The highlighter needs only the lexer and imports it from src/lexer itself.
export const loadCompiler = () => import('../../src/browser.ts');
