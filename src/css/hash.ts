// A short hash of CSS text for class names: FNV-1a, the same in Node and in the browser, so the
// names do not depend on where or when the code is compiled.

export function hash(text: string): string {
  let value = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }

  return (value >>> 0).toString(36);
}
