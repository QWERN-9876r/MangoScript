import type * as ast from './ast.ts';

// Web components from `@html-tag` components: their tags, attributes and the names they cannot use.

/** `mainPage` and `MainPage` → `main-page`, `HTMLView` → `html-view`. */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** The tag of a web component: given by `@html-tag("app-page")`, or its name in kebab case. */
export function htmlTagName(component: ast.ComponentDeclaration): string {
  return component.htmlTag?.name?.value ?? kebabCase(component.name.name);
}

/** The attribute of a property: `itemCount` → `item-count` (attributes do not keep case). */
export function attributeName(property: string): string {
  return kebabCase(property);
}

const RESERVED_TAGS = new Set([
  'annotation-xml',
  'color-profile',
  'font-face',
  'font-face-src',
  'font-face-uri',
  'font-face-format',
  'font-face-name',
  'missing-glyph',
]);

/** Why HTML does not accept a name of a custom element, or `null` if it does. */
export function tagNameProblem(tag: string): string | null {
  if (!/^[a-z][a-z0-9._-]*$/.test(tag)) {
    return 'it must start with a lowercase letter and have only lowercase letters, digits, "-", "." and "_"';
  }
  if (!tag.includes('-')) return 'it must have a hyphen';
  if (RESERVED_TAGS.has(tag)) return 'HTML reserves this name';
  return null;
}

/**
 * Properties of HTMLElement that a web component's properties would replace, breaking the
 * element: `id`, `style`, `hidden`...
 */
export const RESERVED_PROPERTIES: ReadonlySet<string> = new Set([
  'id',
  'className',
  'classList',
  'style',
  'slot',
  'hidden',
  'dir',
  'lang',
  'tabIndex',
  'part',
  'dataset',
  'attributes',
  'shadowRoot',
  'innerHTML',
  'outerHTML',
  'innerText',
  'textContent',
  'tagName',
  'localName',
  'nodeName',
  'nodeType',
  'isConnected',
  'ownerDocument',
  'parentNode',
  'parentElement',
  'childNodes',
  'firstChild',
  'lastChild',
]);

/** How an attribute sets a property: as text, as a number, or by its presence. */
export type AttributeKind = 'string' | 'number' | 'bool';

/**
 * The attribute kind of a property by its type: `string`, `?number`, `"s" | "m"` have attributes;
 * arrays, objects and functions are set only as JS properties (`null`).
 */
export function attributeKind(
  type: ast.TypeNode | null,
  aliases: ReadonlyMap<string, ast.TypeNode>,
  seen = new Set<string>(),
): AttributeKind | null {
  if (type === null) return null;
  switch (type.kind) {
    case 'NullableType':
      return attributeKind(type.type, aliases, seen);
    case 'LiteralType':
      return type.value.kind === 'StringLiteral'
        ? 'string'
        : type.value.kind === 'NumberLiteral'
          ? 'number'
          : 'bool';
    case 'UnionType': {
      const kinds = new Set(type.types.map((member) => attributeKind(member, aliases, seen)));
      const [kind] = kinds;
      return kinds.size === 1 && kind !== undefined ? kind : null;
    }
    case 'TypeReference': {
      const name = type.name.name;
      const alias = aliases.get(name);
      if (alias && !seen.has(name)) return attributeKind(alias, aliases, seen.add(name));
      return name === 'string' || name === 'number' || name === 'bool' ? name : null;
    }
    default:
      return null;
  }
}
