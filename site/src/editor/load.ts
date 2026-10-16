// The editor of VS Code is larger than the rest of the page, so the playground loads it when it is
// about to be seen, and Vite puts it into chunks of its own. The loading is here because
// MangoScript has no import() yet.
export const loadEditor = () => import('./editor.ts');
