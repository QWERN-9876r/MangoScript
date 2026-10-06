// Small functions that a module gets only when its code needs them.

export type Helper = 'runDeferred' | 'append';

export const HELPERS: Readonly<Record<Helper, readonly string[]>> = {
  /** Runs deferred calls in reverse order; every call runs even if an earlier one throws. */
  runDeferred: [
    'function $$runDeferred(deferred) {',
    '  let failure;',
    '  for (let i = deferred.length - 1; i >= 0; i--) {',
    '    try {',
    '      deferred[i]();',
    '    } catch (error) {',
    '      failure = { error };',
    '    }',
    '  }',
    '  if (failure) throw failure.error;',
    '}',
  ],
  /** Appends element content whose type is not known: null adds nothing, arrays add each item. */
  append: [
    'function $$append(parent, value) {',
    '  if (value == null || value === false) return;',
    '  if (Array.isArray(value)) {',
    '    for (const item of value) $$append(parent, item);',
    '  } else {',
    '    parent.append(value);',
    '  }',
    '}',
  ],
};
