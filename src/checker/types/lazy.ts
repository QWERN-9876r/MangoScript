/**
 * A map whose keys are known up front and whose values are computed when first read. Members of
 * types from `.d.ts` files use it: `@types/node` has thousands of them, and few are ever used.
 */
export class LazyMap<V> extends Map<string, V> {
  private names: Set<string> | null = null;
  private complete = false;
  private filling = false;
  private readonly listNames: () => Iterable<string>;
  private readonly compute: (name: string) => V | undefined;

  constructor(listNames: () => Iterable<string>, compute: (name: string) => V | undefined) {
    super();
    this.listNames = listNames;
    this.compute = compute;
  }

  private known(): Set<string> {
    this.names ??= new Set(this.listNames());
    return this.names;
  }

  /** The names, without computing the values. */
  knownNames(): Iterable<string> {
    return this.known();
  }

  /** Computes every value, keeping the order of the names. */
  private fill(): void {
    if (this.complete || this.filling) return;
    this.filling = true;
    const values = [...this.known()].map((name) => [name, this.get(name)] as const);
    this.complete = true;
    this.filling = false;
    super.clear();
    for (const [name, value] of values) if (value !== undefined) super.set(name, value);
  }

  override get(name: string): V | undefined {
    if (super.has(name)) return super.get(name);
    if (this.complete || !this.known().has(name)) return undefined;
    const value = this.compute(name);
    if (value === undefined) this.names!.delete(name);
    else super.set(name, value);
    return value;
  }

  override has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  override set(name: string, value: V): this {
    this.known().add(name);
    return super.set(name, value);
  }

  override delete(name: string): boolean {
    const known = this.known().delete(name);
    return super.delete(name) || known;
  }

  override clear(): void {
    this.names = new Set();
    this.complete = true;
    super.clear();
  }

  override get size(): number {
    this.fill();
    return super.size;
  }

  override keys(): MapIterator<string> {
    this.fill();
    return super.keys();
  }

  override values(): MapIterator<V> {
    this.fill();
    return super.values();
  }

  override entries(): MapIterator<[string, V]> {
    this.fill();
    return super.entries();
  }

  override forEach(callback: (value: V, key: string, map: Map<string, V>) => void): void {
    this.fill();
    super.forEach(callback);
  }

  override [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }
}

/** The names of a map of members, without computing a lazy one. */
export function memberNames<V>(map: Map<string, V>): Iterable<string> {
  return map instanceof LazyMap ? map.knownNames() : map.keys();
}
