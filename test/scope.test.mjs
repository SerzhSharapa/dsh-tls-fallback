import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderScope } from '../src/scope.mjs';

const pause = () => Promise.resolve();

test('parallel lazy streams preserve provider identity across async next and never leak caller scope', async () => {
  const scope = createProviderScope();
  const seen = [];
  function stream(provider) {
    return scope.wrap({ provider }, () => {
      assert.equal(scope.current().provider, provider);
      return (async function* () {
        for (let i = 0; i < 3; i++) {
          assert.equal(scope.current().provider, provider);
          await pause();
          seen.push([provider, scope.current().provider]);
          yield { origin: 'https://example.test', i };
        }
      })();
    });
  }
  const selected = stream('selected');
  const unselected = stream('unselected');
  assert.equal(selected[Symbol.asyncIterator](), selected);
  assert.equal(scope.current(), undefined);
  for (let i = 0; i < 4; i++) {
    const pending = [selected.next(), unselected.next()];
    assert.equal(scope.current(), undefined);
    const results = await Promise.all(pending);
    assert.equal(scope.current(), undefined);
    assert.equal(results[0].done, i === 3);
    assert.deepEqual(results[0], results[1]);
  }
  assert.equal(seen.length, 6);
  assert.ok(seen.every(([expected, actual]) => expected === actual));
});

test('nested unselected and missing provider override rather than inherit outer selection', async () => {
  const scope = createProviderScope();
  const outer = scope.wrap({ provider: 'selected' }, () => (async function* () {
    for (const provider of ['unselected', undefined]) {
      const nested = scope.wrap({ provider }, () => {
        assert.equal(scope.current().provider, provider);
        return (async function* () {
          await pause();
          assert.equal(scope.current().provider, provider);
          yield scope.current();
        })();
      });
      assert.equal(scope.current().provider, 'selected');
      assert.deepEqual((await nested.next()).value, { provider });
      await nested.return();
      assert.equal(scope.current().provider, 'selected');
    }
    yield 'outer';
  })());
  assert.deepEqual(await outer.next(), { value: 'outer', done: false });
  assert.equal(scope.current(), undefined);
  await outer.return();
  assert.equal(scope.current(), undefined);
});

test('next values and return values are forwarded with asynchronous cleanup in provider scope', async () => {
  const scope = createProviderScope();
  const cleanup = [];
  const stream = scope.wrap({ provider: 'selected' }, () => (async function* () {
    try {
      const value = yield 'ready';
      assert.equal(scope.current().provider, 'selected');
      yield value;
    } finally {
      cleanup.push(scope.current().provider);
      await pause();
      cleanup.push(scope.current().provider);
    }
  })());
  assert.deepEqual(await stream.next(), { value: 'ready', done: false });
  assert.deepEqual(await stream.next('input'), { value: 'input', done: false });
  const pending = stream.return('stop');
  assert.equal(scope.current(), undefined);
  assert.deepEqual(await pending, { value: 'stop', done: true });
  assert.deepEqual(cleanup, ['selected', 'selected']);
  assert.equal(scope.current(), undefined);
  assert.deepEqual(await stream.next(), { value: undefined, done: true });
});

test('throw forwards original error and runs finally cleanup in provider scope', async () => {
  const scope = createProviderScope();
  const error = new Error('consumer stopped');
  const seen = [];
  const stream = scope.wrap({ provider: 'selected' }, () => (async function* () {
    try { yield 1; }
    catch (caught) {
      assert.equal(caught, error);
      seen.push(scope.current().provider);
      throw caught;
    } finally {
      await pause();
      seen.push(scope.current().provider);
    }
  })());
  await stream.next();
  await assert.rejects(stream.throw(error), candidate => candidate === error);
  assert.deepEqual(seen, ['selected', 'selected']);
  assert.equal(scope.current(), undefined);
  assert.equal((await stream.next()).done, true);
});

test('for-await break calls return and cleans up without caller context leakage', async () => {
  const scope = createProviderScope();
  let cleaned = false;
  const stream = scope.wrap({ provider: 'selected' }, () => (async function* () {
    try { yield 1; yield 2; }
    finally { await pause(); assert.equal(scope.current().provider, 'selected'); cleaned = true; }
  })());
  for await (const item of stream) {
    assert.equal(item, 1);
    assert.equal(scope.current(), undefined);
    break;
  }
  assert.equal(cleaned, true);
  assert.equal(scope.current(), undefined);
});

test('optional return and throw fallback follow async iterator protocol', async () => {
  const scope = createProviderScope();
  const stream = scope.wrap({ provider: 'selected' }, () => ({
    [Symbol.asyncIterator]() {
      assert.equal(scope.current().provider, 'selected');
      return { async next(value) { assert.equal(scope.current().provider, 'selected'); return { value, done: false }; } };
    },
  }));
  assert.deepEqual(await stream.next(42), { value: 42, done: false });
  assert.deepEqual(await stream.return('end'), { value: 'end', done: true });
  const error = new Error('throw fallback');
  await assert.rejects(stream.throw(error), candidate => candidate === error);
  assert.equal(scope.current(), undefined);
});

test('synchronous factory and iterator method failures restore caller scope', () => {
  const scope = createProviderScope();
  const error = new Error('failure');
  assert.throws(() => scope.wrap({ provider: 'selected' }, () => { throw error; }), candidate => candidate === error);
  assert.equal(scope.current(), undefined);
  const stream = scope.wrap({ provider: 'selected' }, () => ({
    [Symbol.asyncIterator]() { return this; },
    next() { assert.equal(scope.current().provider, 'selected'); throw error; },
    return() { assert.equal(scope.current().provider, 'selected'); throw error; },
    throw() { assert.equal(scope.current().provider, 'selected'); throw error; },
  }));
  for (const method of ['next', 'return', 'throw']) {
    assert.throws(() => stream[method](), candidate => candidate === error);
    assert.equal(scope.current(), undefined);
  }
});
