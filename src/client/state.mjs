// UI-only helpers; this module neither imports the host nor inspects credentials.
export function selectedProviders(value) {
  return [...new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string') : [])];
}

export function providerRows(active, selected) {
  const rows = new Map();
  for (const item of active) {
    if (typeof item.id === 'string') rows.set(item.id, { id: item.id, name: item.name || item.id, available: true });
  }
  for (const id of selectedProviders(selected)) {
    if (!rows.has(id)) rows.set(id, { id, name: id, available: false });
  }
  return [...rows.values()];
}

export function toggleProvider(selected, id, checked) {
  const ids = selectedProviders(selected);
  return checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id);
}

export function createController(ctx) {
  const form = ctx.configForms.get('dsh-tls-fallback');
  let state = { form: form.getSnapshot(), active: [], loading: true, providerError: false, writeError: null, busy: false };
  const listeners = new Set();
  let disposed = false;
  let generation = 0;
  const update = patch => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const unsubscribe = form.subscribe(() => update({ form: form.getSnapshot() }));
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async load() {
      const request = ++generation;
      update({ loading: true, providerError: false });
      try {
        const result = await ctx.remote.llm.listProviders();
        if (!result.ok || !Array.isArray(result.value)) throw new Error('Provider list unavailable');
        if (request === generation) update({ active: result.value, loading: false });
      } catch {
        if (request === generation) update({ active: [], loading: false, providerError: true });
      }
    },
    async save(field, value, expectedRevision) {
      if (disposed || state.busy) return;
      update({ busy: true, writeError: null });
      try {
        const accepted = await form.mutate([{ op: 'set', path: [field], value }], expectedRevision);
        // ConfigForms recovers its mirror before returning false; never retry stale edits.
        update({ form: form.getSnapshot(), writeError: accepted ? null : 'conflict' });
      } catch {
        update({ form: form.getSnapshot(), writeError: 'saveError' });
      } finally {
        update({ busy: false });
      }
    },
    dispose() { disposed = true; generation++; unsubscribe(); listeners.clear(); },
  };
}
