import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, liveConfig } from '../src/config.mjs';

test('published defaults are opt-in: no selected providers', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(liveConfig(Config({})))),
    { enabled: true, providers: [], staggerMs: 250, timeoutMs: 10000 });
});

test('volatile provider selection and enabled values are read on every access', () => {
  let selected = ['first'], enabled = true;
  const live = liveConfig({ providers: { get: () => selected }, enabled: { get: () => enabled }, staggerMs: 250, timeoutMs: 10000 });
  assert.deepEqual(live.providers, ['first']); assert.equal(live.enabled, true);
  selected = ['second']; enabled = false;
  assert.deepEqual(live.providers, ['second']); assert.equal(live.enabled, false);
});

test('schema accepts valid provider selection and rejects invalid fields', () => {
  assert.deepEqual(Config({ providers: ['provider-id'], enabled: false }).providers.get(), ['provider-id']);
  for (const invalid of [{ providers: [''] }, { providers: [false] }, { staggerMs: 0 }, { staggerMs: 2001 }, { timeoutMs: 2000 }, { timeoutMs: 60001 }]) {
    assert.throws(() => Config(invalid));
  }
});
