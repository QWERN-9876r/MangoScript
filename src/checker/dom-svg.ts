import { ELEMENT_MEMBERS } from './dom.ts';
import { ANY, property, type Member, type ObjectType, type Type } from './types.ts';

// SVG elements among the built-in DOM types, for the compiler without TypeScript's lib.dom: the
// members of any element, and `className`, which in SVG is an object, not a string.

function object(name: string, members: Record<string, Member>): ObjectType {
  return { kind: 'object', name, members: new Map(Object.entries(members)), call: null };
}

const SVG_MEMBERS: Record<string, Member> = { ...ELEMENT_MEMBERS, className: property(ANY) };

export const SVG_ELEMENT = object('SVGElement', SVG_MEMBERS);
export const SVG_SVG_ELEMENT = object('SVGSVGElement', SVG_MEMBERS);

/** The type of the SVG element `<tag>` creates. */
export function svgElementType(tag: string): ObjectType {
  return tag === 'svg' ? SVG_SVG_ELEMENT : SVG_ELEMENT;
}

/** SVG types that programs can name, e.g. `ref icon SVGSVGElement`. */
export const SVG_TYPES: ReadonlyMap<string, Type> = new Map<string, Type>([
  ['SVGElement', SVG_ELEMENT],
  ['SVGSVGElement', SVG_SVG_ELEMENT],
]);
