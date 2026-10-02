import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, providerRows, selectedProviders, toggleProvider } from '../src/client/state.mjs';

function fixture(mutate = async () => true) {
  let snapshot = { status: 'ready', value: { enabled: true, providers: ['missing'] }, revision: 1, writable: true };
  let listener;
  let unsubscribed = false;
  const form = { getSnapshot: () => snapshot, subscribe(fn) { listener = fn; return () => { unsubscribed = true; }; }, mutate };
  const ctx = { configForms: { get(id) { assert.equal(id, 'dsh-tls-fallback'); return form; } }, remote: { llm: { listProviders: async () => ({ ok: true, value: [{ id: 'active', name: 'Active' }] }) } } };
  return { ctx, set(value) { snapshot = value; listener(); }, get unsubscribed() { return unsubscribed; } };
}

test('active providers plus disappeared selected IDs; no selected ID is dropped', () => {
  assert.deepEqual(selectedProviders(['a', 'a', null, 'missing']), ['a', 'missing']);
  assert.deepEqual(providerRows([{ id: 'a', name: 'A' }], ['a', 'missing']), [
    { id: 'a', name: 'A', available: true }, { id: 'missing', name: 'missing', available: false },
  ]);
  assert.deepEqual(toggleProvider(['missing'], 'a', true), ['missing', 'a']);
  assert.deepEqual(toggleProvider(['missing', 'a'], 'a', false), ['missing']);
  assert.deepEqual(toggleProvider(['missing'], 'missing', false), []);
});

test('write carries explicit revision and displays rejected-write error with recovered snapshot', async () => {
  const f = fixture(async (ops, revision) => {
    assert.deepEqual(ops, [{ op: 'set', path: ['enabled'], value: false }]);
    assert.equal(revision, 1);
    f.set({ status: 'ready', value: { enabled: true, providers: ['other'] }, revision: 2, writable: true });
    return false;
  });
  const controller = createController(f.ctx);
  await controller.save('enabled', false, 1);
  assert.equal(controller.getSnapshot().writeError, 'conflict');
  assert.equal(controller.getSnapshot().form.revision, 2);
  assert.equal(controller.getSnapshot().busy, false);
  controller.dispose();
  assert.equal(f.unsubscribed, true);
});

test('thrown write failures are visible, accepted writes clear the error', async () => {
  let fail = true;
  const f = fixture(async () => { if (fail) throw new Error('offline'); return true; });
  const c = createController(f.ctx);
  await c.save('providers', [], 1);
  assert.equal(c.getSnapshot().writeError, 'saveError');
  fail = false;
  await c.save('providers', [], 1);
  assert.equal(c.getSnapshot().writeError, null);
  c.dispose();
});

test('provider reload errors preserve selected unavailable rows and permit retry', async () => {
  const f = fixture();
  const c = createController(f.ctx);
  await c.load();
  assert.equal(c.getSnapshot().active[0].id, 'active');
  f.ctx.remote.llm.listProviders = async () => ({ ok: false });
  await c.load();
  assert.equal(c.getSnapshot().providerError, true);
  assert.deepEqual(providerRows(c.getSnapshot().active, c.getSnapshot().form.value.providers), [{ id: 'missing', name: 'missing', available: false }]);
  f.ctx.remote.llm.listProviders = async () => ({ ok: true, value: [] });
  await c.load();
  assert.equal(c.getSnapshot().providerError, false);
  c.dispose();
});

test('stale provider responses cannot replace newer state', async () => {
  const f = fixture();
  let resolveFirst;
  f.ctx.remote.llm.listProviders = () => new Promise(resolve => { resolveFirst = resolve; });
  const c = createController(f.ctx);
  const first = c.load();
  f.ctx.remote.llm.listProviders = async () => ({ ok: true, value: [{ id: 'new' }] });
  await c.load();
  resolveFirst({ ok: true, value: [{ id: 'old' }] });
  await first;
  assert.equal(c.getSnapshot().active[0].id, 'new');
  c.dispose();
});
