import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderScope } from '../src/scope.mjs';
import { eligibleOrigin, installTransport } from '../src/transport.mjs';

const marker = Symbol.for('dsh-tls-fallback.transport');
const origin = 'https://example.test';

function fixture(t, overrides = {}) {
  const calls = [];
  const agents = [];
  const pools = [];
  const connectors = [];
  const routes = [];
  const reports = [];
  const config = { enabled: true, providers: ['selected'], staggerMs: 250, timeoutMs: 10000 };
  let current = { provider: 'selected' };
  const previous = {
    closeCalls: 0, destroyCalls: 0,
    dispatch(options, handler) { calls.push({ owner: 'previous', options, handler }); return false; },
    close() { this.closeCalls++; return Promise.resolve(); },
    destroy() { this.destroyCalls++; return Promise.resolve(); },
  };
  let globalDispatcher = previous;
  class Pool {
    constructor(url, options) { this.origin = String(url); this.options = options; pools.push(this); }
    dispatch(options, handler) { calls.push({ owner: this, options, handler }); return true; }
  }
  class Agent {
    constructor(options) { this.options = options; this.pools = new Map(); this.closeCalls = 0; this.destroyCalls = []; agents.push(this); }
    dispatch(options, handler) {
      const key = String(options.origin);
      if (!this.pools.has(key)) this.pools.set(key, this.options.factory(key, { connections: this.options.connections, pipelining: this.options.pipelining }));
      return this.pools.get(key).dispatch(options, handler);
    }
    close() { this.closeCalls++; return this.closeFailure ? Promise.reject(this.closeFailure) : Promise.resolve(); }
    destroy(error) { this.destroyCalls.push(error); return this.destroyFailure ? Promise.reject(this.destroyFailure) : Promise.resolve(); }
  }
  const undici = { Agent, Pool,
    getGlobalDispatcher: () => globalDispatcher,
    setGlobalDispatcher: dispatcher => { globalDispatcher = dispatcher; },
  };
  const installOptions = {
    undici, config,
    currentScope: () => current,
    proxyRouteFor(url) { routes.push(url); return { proxied: false }; },
    connectorFactory(options) {
      const connect = () => { throw new Error('Mock Pool must not perform network IO'); };
      connect.options = options; connect.disposeCalls = 0;
      connect.dispose = () => { connect.disposeCalls++; };
      connectors.push(connect); return connect;
    },
    onResult: result => reports.push(result),
    ...overrides,
  };
  const dispose = installTransport(installOptions);
  const routed = globalDispatcher;
  t.after(async () => {
    // Ensure even intentionally rejected lifecycle tests clean up the marker.
    agents[0].destroyFailure = undefined;
    try { await dispose(); } catch { /* tested lifecycle rejection */ }
    if (globalThis[marker] === routed) delete globalThis[marker];
  });
  return { calls, agents, pools, connectors, routes, reports, config, previous, undici, routed, dispose, installOptions,
    scope: value => { current = value; },
    dispatch(extra = {}, handler = {}) { const options = { origin, path: '/v1/chat/completions', method: 'POST', body: 'payload', ...extra }; return routed.dispatch(options, handler); },
  };
}

for (const input of ['https://example.test', 'https://example.test:8443', new URL('https://example.test')]) {
  test(`eligible DNS HTTPS origin ${input}`, () => {
    const url = eligibleOrigin(input); assert.ok(url instanceof URL); assert.equal(url.hostname, 'example.test');
  });
}
for (const input of ['http://example.test', 'ws://example.test', 'wss://example.test', 'https://192.0.2.1', 'https://[2001:db8::1]', 'https://[::1]:8443', 'https://127.1', 'https://2130706433', 'https://user:secret@example.test', 'https://bad_name.test', 'https://example.test:0', 'not a URL', undefined, null]) {
  test(`ineligible origin ${input}`, () => assert.equal(eligibleOrigin(input), null));
}

for (const scenario of ['disabled', 'empty selection', 'unselected', 'missing scope', 'missing provider']) {
  test(`${scenario} bypasses fallback without even inspecting proxy policy`, async (t) => {
    const f = fixture(t);
    if (scenario === 'disabled') f.config.enabled = false;
    if (scenario === 'empty selection') f.config.providers = [];
    if (scenario === 'unselected') f.scope({ provider: 'unselected' });
    if (scenario === 'missing scope') f.scope(undefined);
    if (scenario === 'missing provider') f.scope({});
    const handler = { marker: 'same handler' };
    assert.equal(f.dispatch({}, handler), false);
    assert.equal(f.calls[0].owner, 'previous'); assert.equal(f.calls[0].handler, handler);
    assert.equal(f.calls[0].options.body, 'payload');
    assert.equal(f.routes.length, 0); assert.equal(f.pools.length, 0); assert.equal(f.connectors.length, 0);
  });
}

test('selected direct DNS HTTPS uses owned Agent factory Pools and retains request identity exactly once', (t) => {
  const f = fixture(t);
  const request = { origin, path: '/api', method: 'POST', body: { untouched: true } };
  const handler = {};
  assert.equal(f.routed.dispatch(request, handler), true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options, request); assert.equal(f.calls[0].handler, handler);
  assert.equal(f.calls[0].owner, f.pools[0]);
  assert.equal(f.agents[0].options.connections, 4); assert.equal(f.agents[0].options.pipelining, 1);
  assert.equal(f.pools[0].options.connections, 4); assert.equal(f.pools[0].options.pipelining, 1);
  assert.equal(f.pools[0].options.connect, f.connectors[0]);
  assert.equal(f.connectors[0].options.hostname, 'example.test'); assert.equal(f.connectors[0].options.port, 443);
  assert.equal(f.connectors[0].options.staggerMs, 250); assert.equal(f.connectors[0].options.timeoutMs, 10000);
  f.dispatch(); assert.equal(f.pools.length, 1); assert.equal(f.calls.length, 2);
  assert.equal(f.previous.closeCalls, 0); assert.equal(f.previous.destroyCalls, 0);
  f.connectors[0].options.onResult({ ok: true, attempts: 2 });
  assert.deepEqual(f.reports, [{ ok: true, attempts: 2, hostname: 'example.test' }]);
});

test('distinct DNS origins and custom HTTPS ports get scoped connectors', (t) => {
  const f = fixture(t);
  f.dispatch(); f.dispatch({ origin: 'https://example.test:8443' }); f.dispatch({ origin: 'https://other.test' });
  assert.equal(f.pools.length, 3);
  assert.deepEqual(f.connectors.map(c => [c.options.hostname, c.options.port]), [['example.test', 443], ['example.test', 8443], ['other.test', 443]]);
});

test('proxy routes stay with previous dispatcher without creating TLS connectors', (t) => {
  const inspected = [];
  const f = fixture(t, { proxyRouteFor(url) { inspected.push(url); return { proxied: true }; } });
  assert.equal(f.dispatch(), false); assert.equal(f.calls[0].owner, 'previous');
  assert.equal(inspected[0].origin, origin); assert.equal(f.pools.length, 0); assert.equal(f.connectors.length, 0);
});

test('IP, non-HTTPS and invalid origins bypass even for selected providers', (t) => {
  const f = fixture(t);
  for (const value of ['https://192.0.2.1', 'https://[2001:db8::1]:8443', 'http://example.test', 'wss://example.test', 'bad']) {
    assert.equal(f.dispatch({ origin: value }), false);
  }
  assert.ok(f.calls.every(call => call.owner === 'previous')); assert.equal(f.routes.length, 0); assert.equal(f.pools.length, 0);
});

test('parallel streams sharing an HTTPS origin isolate selected/unselected while plain calls bypass', async (t) => {
  const scope = createProviderScope();
  const f = fixture(t, { currentScope: scope.current });
  function stream(provider) {
    return scope.wrap({ provider }, () => (async function* () {
      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        yield f.dispatch({ tag: provider });
      }
    })());
  }
  const a = stream('selected'); const b = stream('unselected');
  for (let i = 0; i < 3; i++) {
    const [selected, unselected] = await Promise.all([a.next(), b.next()]);
    assert.equal(selected.value, true); assert.equal(unselected.value, false);
    assert.equal(scope.current(), undefined);
    assert.equal(f.dispatch({ tag: 'outside LLM' }), false);
  }
  await Promise.all([a.return(), b.return()]);
  assert.equal(f.pools.length, 1);
  for (const call of f.calls) assert.equal(call.owner === 'previous', call.options.tag !== 'selected');
});

test('live enable and selection changes apply on next dispatch without reinstallation', (t) => {
  const f = fixture(t);
  assert.equal(f.dispatch(), true);
  f.config.enabled = false; assert.equal(f.dispatch(), false);
  f.config.enabled = true; f.config.providers = []; assert.equal(f.dispatch(), false);
  f.config.providers = ['other']; assert.equal(f.dispatch(), false);
  f.scope({ provider: 'other' }); assert.equal(f.dispatch(), true);
  assert.equal(f.pools.length, 1); assert.equal(f.dispose.isActive(), true);
  f.config.staggerMs = 100; f.config.timeoutMs = 2000;
  f.dispatch({ origin: 'https://new.test:8443' });
  assert.equal(f.connectors[1].options.staggerMs, 100); assert.equal(f.connectors[1].options.timeoutMs, 2000);
});

test('dispose restores previous dispatcher and marker, cancels owned connectors once, never closes previous', async (t) => {
  const f = fixture(t); f.dispatch(); f.dispatch({ origin: 'https://other.test' });
  assert.equal(globalThis[marker], f.routed); assert.equal(f.dispose.isActive(), true);
  const promise = f.dispose(); assert.equal(f.dispose(), promise); await promise;
  assert.equal(f.undici.getGlobalDispatcher(), f.previous); assert.equal(globalThis[marker], undefined);
  assert.equal(f.dispose.isActive(), false); assert.equal(f.agents[0].destroyCalls.length, 1);
  assert.ok(f.connectors.every(c => c.disposeCalls === 1));
  assert.equal(f.previous.closeCalls, 0); assert.equal(f.previous.destroyCalls, 0);
  assert.equal(f.dispatch(), false); assert.equal(f.calls.at(-1).owner, 'previous');
});

test('dispose does not overwrite a later global dispatcher or destroy foreign resources', async (t) => {
  const f = fixture(t); f.dispatch();
  const foreign = { destroy() { assert.fail('foreign destroyed'); }, close() { assert.fail('foreign closed'); } };
  f.undici.setGlobalDispatcher(foreign);
  assert.equal(f.dispose.isActive(), false);
  await f.dispose();
  assert.equal(f.undici.getGlobalDispatcher(), foreign); assert.equal(globalThis[marker], undefined);
  assert.equal(f.previous.destroyCalls, 0);
});

test('duplicate install is rejected without allocating another Agent and disposal permits reinstall', async (t) => {
  const f = fixture(t);
  assert.throws(() => installTransport(f.installOptions), /already active/);
  assert.equal(f.agents.length, 1); assert.equal(f.undici.getGlobalDispatcher(), f.routed);
  await f.dispose();
  const replacement = installTransport(f.installOptions);
  assert.equal(replacement.isActive(), true); assert.equal(f.agents.length, 2);
  await replacement(); assert.equal(f.undici.getGlobalDispatcher(), f.previous); assert.equal(globalThis[marker], undefined);
});

for (const callback of [false, true]) {
  test(`close ${callback ? 'callback' : 'promise'} detaches and gracefully closes owned Agent only`, async (t) => {
    const f = fixture(t); f.dispatch();
    if (callback) {
      await new Promise((resolve, reject) => {
        const result = f.routed.close(error => error ? reject(error) : resolve());
        assert.equal(result, undefined);
      });
    } else await f.routed.close();
    assert.equal(f.undici.getGlobalDispatcher(), f.previous); assert.equal(globalThis[marker], undefined);
    assert.equal(f.dispose.isActive(), false); assert.equal(f.agents[0].closeCalls, 1);
    await f.routed.close(); assert.equal(f.agents[0].closeCalls, 1);
    assert.equal(f.previous.closeCalls, 0); assert.equal(f.previous.destroyCalls, 0);
    assert.equal(f.dispatch(), false);
  });
}

for (const variant of ['promise', 'callback', 'error and callback']) {
  test(`destroy ${variant} cancels connectors and restores dispatcher`, async (t) => {
    const f = fixture(t); f.dispatch(); const error = new Error('shutdown');
    if (variant === 'promise') await f.routed.destroy(error);
    else await new Promise((resolve, reject) => {
      const callback = cause => cause ? reject(cause) : resolve();
      const result = variant === 'callback' ? f.routed.destroy(callback) : f.routed.destroy(error, callback);
      assert.equal(result, undefined);
    });
    assert.equal(f.agents[0].destroyCalls[0], variant === 'callback' ? undefined : error);
    assert.equal(f.connectors[0].disposeCalls, 1);
    assert.equal(f.undici.getGlobalDispatcher(), f.previous); assert.equal(globalThis[marker], undefined);
    assert.equal(f.previous.destroyCalls, 0); assert.equal(f.previous.closeCalls, 0);
  });
}

test('lifecycle callback receives owned Agent close failure after route is restored', async (t) => {
  const f = fixture(t); const error = new Error('close failure'); f.agents[0].closeFailure = error;
  await new Promise(resolve => f.routed.close(cause => { assert.equal(cause, error); resolve(); }));
  assert.equal(f.undici.getGlobalDispatcher(), f.previous); assert.equal(globalThis[marker], undefined);
});

test('lifecycle callback receives owned Agent destroy failure after route is restored', async (t) => {
  const f = fixture(t); const error = new Error('destroy failure'); f.agents[0].destroyFailure = error;
  await new Promise(resolve => f.routed.destroy(cause => { assert.equal(cause, error); resolve(); }));
  assert.equal(f.undici.getGlobalDispatcher(), f.previous); assert.equal(globalThis[marker], undefined);
});
