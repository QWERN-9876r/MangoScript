// Who holds a channel. A channel is data, `{ $$chan: id, size, zero }`, and each thread that gets
// one gets a copy of it, so the main thread, which keeps what channels hold, cannot know from its
// own objects when a channel is no longer used. It counts the values of each channel in all
// threads instead: a thread counts the copies it sends before it sends them, and a thread that has
// a copy lets go of it when the copy is collected (FinalizationRegistry). A channel that nobody
// holds is forgotten.

export type HoldHelper = 'hold' | 'holdWorker';

/** The channels in a value that goes to a thread: the objects, as each becomes a copy there. */
const CHANNELS_IN = [
  'function $$channelsIn(value, found = new Set(), seen = new Set()) {',
  '  if (typeof value !== "object" || value === null || seen.has(value)) return found;',
  '  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return found;',
  '  seen.add(value);',
  '  if (typeof value.$$chan === "string") return found.add(value);',
  '  const items =',
  '    value instanceof Map',
  '      ? [...value.keys(), ...value.values()]',
  '      : value instanceof Set || Array.isArray(value)',
  '        ? value',
  '        : Object.values(value);',
  '  for (const item of items) $$channelsIn(item, found, seen);',
  '  return found;',
  '}',
];

export const HOLD_HELPERS: Readonly<Record<HoldHelper, readonly string[]>> = {
  /** The main thread: the registry of channels, which the modules of the program share. */
  hold: [
    'const $$channels = Symbol.for("mangoscript.channels");',
    '',
    'function $$registry() {',
    '  return (globalThis[$$channels] ??= {',
    '    next: 0,',
    '    states: new Map(),',
    '    held: new FinalizationRegistry((id) => $$hold(id, -1)),',
    '  });',
    '}',
    '',
    'function $$state(channel) {',
    '  const { states } = $$registry();',
    '  let state = states.get(channel.$$chan);',
    '  if (!state) {',
    '    state = { buffer: [], receivers: [], senders: [], closed: false, holders: 0 };',
    '    states.set(channel.$$chan, state);',
    '  }',
    '  return state;',
    '}',
    '',
    'function $$hold(id, count) {',
    '  const state = $$state({ $$chan: id });',
    '  state.holders += count;',
    '  if (state.holders <= 0) $$registry().states.delete(id);',
    '}',
    '',
    '// Counts the channels of a value before a copy of it goes to a thread.',
    'function $$retain(value) {',
    '  for (const channel of $$channelsIn(value)) $$hold(channel.$$chan, 1);',
    '}',
    '',
    '// Lets go of the channels of a copy, counted by its sender, when the copy is collected.',
    'function $$adopt(value) {',
    '  for (const channel of $$channelsIn(value)) $$registry().held.register(channel, channel.$$chan);',
    '}',
    '',
    'function $$copy(value) {',
    '  $$retain(value);',
    '  const copy = structuredClone(value);',
    '  $$adopt(copy);',
    '  return copy;',
    '}',
    '',
    ...CHANNELS_IN,
  ],
  /** A worker: the counts are kept by the main thread, so it tells the main thread ($$toMain). */
  holdWorker: [
    'const $$held = new FinalizationRegistry((id) => $$toMain({ op: "release", channel: id }));',
    '',
    'function $$retain(value) {',
    '  for (const channel of $$channelsIn(value)) $$toMain({ op: "retain", channel: channel.$$chan });',
    '}',
    '',
    'function $$adopt(value) {',
    '  for (const channel of $$channelsIn(value)) $$held.register(channel, channel.$$chan);',
    '}',
    '',
    ...CHANNELS_IN,
  ],
};
