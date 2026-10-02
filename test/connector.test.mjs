import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createConnector } from '../src/connector.mjs';

const hostname = 'example.test';
const options = { hostname, protocol: 'https:', port: 443 };
const records = [
  { address: '192.0.2.1', family: 4 },
  { address: '2001:db8::2', family: 6 },
  { address: '192.0.2.3', family: 4 },
];

// A deterministic clock: no real network, sleeps, or wall-clock assertions.
function clock(t) {
  let now = 0;
  let id = 0;
  const tasks = new Map();
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => {
    const key = ++id;
    tasks.set(key, { fn, at: now + delay });
    return key;
  });
  t.mock.method(globalThis, 'clearTimeout', (key) => tasks.delete(key));
  t.mock.method(Date, 'now', () => now);
  return {
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next || next[1].at > end) break;
        tasks.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    get pending() { return tasks.size; },
  };
}

class FakeSocket extends EventEmitter {
  authorized = true;
  destroyed = false;
  destroyCalls = 0;
  constructor(config) { super(); this.config = config; this.remoteAddress = config.host; }
  destroy() { this.destroyed = true; this.destroyCalls++; return this; }
  setNoDelay(value) { this.noDelay = value; return this; }
  setKeepAlive(...args) { this.keepAlive = args; return this; }
}

function fixture(t, overrides = {}) {
  const time = clock(t);
  const sockets = [];
  const calls = [];
  const reports = [];
  const lookups = [];
  let dnsCallback;
  const connect = createConnector({
    hostname, staggerMs: 25, timeoutMs: 100,
    lookup(name, opts, cb) { lookups.push({ name, opts }); dnsCallback = cb; },
    dial(config) { const socket = new FakeSocket(config); sockets.push(socket); return socket; },
    onResult(result) { reports.push(result); },
    ...overrides,
  });
  t.after(() => connect.dispose());
  return { connect, time, sockets, calls, reports, lookups,
    start(extra = {}) { connect({ ...options, ...extra }, (...args) => calls.push(args)); },
    resolve(...args) { const result = args.length ? args[0] : records; dnsCallback(args[1] ?? null, result); },
  };
}

function assertFinished(f, code) {
  assert.equal(f.calls.length, 1);
  if (code) assert.equal(f.calls[0][0].code, code);
  assert.equal(f.reports.length, 1);
  assert.equal(f.time.pending, 0);
}

test('TLS-stalled first address loses to healthy second; late loser events cannot duplicate callback', (t) => {
  const f = fixture(t); f.start(); f.resolve();
  f.sockets[0].emit('connect'); // TCP alone is not success.
  assert.equal(f.calls.length, 0);
  f.time.tick(24); assert.equal(f.sockets.length, 1);
  f.time.tick(1); assert.equal(f.sockets.length, 2);
  const [loser, winner] = f.sockets;
  winner.emit('secureConnect');
  assertFinished(f);
  assert.deepEqual(f.calls[0], [null, winner]);
  assert.equal(loser.destroyed, true); assert.equal(winner.destroyed, false);
  loser.emit('secureConnect'); loser.emit('error', new Error('late'));
  winner.emit('secureConnect');
  f.time.tick(1000);
  assert.equal(f.calls.length, 1); assert.equal(f.sockets.length, 2);
  assert.deepEqual(f.reports[0], { ok: true, attempts: 2, durationMs: 25, code: undefined, address: records[1].address });
});

test('first TLS success cancels subsequent attempts and dispose does not destroy handed-off socket', (t) => {
  const f = fixture(t); f.start(); f.resolve();
  f.sockets[0].emit('secureConnect'); f.connect.dispose(); f.time.tick(1000);
  assertFinished(f); assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].destroyed, false);
});

test('immediate socket error launches next address without waiting for stagger', (t) => {
  const f = fixture(t); f.start(); f.resolve();
  f.sockets[0].emit('error', new Error('refused'));
  assert.equal(f.sockets.length, 2); assert.equal(f.sockets[0].destroyed, true);
  f.sockets[1].emit('secureConnect'); assertFinished(f);
});

test('synchronous dial throw advances to healthy address', (t) => {
  let attempt = 0; let winner;
  const f = fixture(t, { dial(config) { if (++attempt === 1) throw new Error('dial failed'); return winner = new FakeSocket(config); } });
  f.start(); f.resolve(records.slice(0, 2)); winner.emit('secureConnect');
  assertFinished(f); assert.equal(attempt, 2); assert.equal(f.calls[0][1], winner);
});

test('synchronous dial throw with more candidates leaves no orphan stagger timer', (t) => {
  let attempt = 0; const sockets = [];
  const f = fixture(t, { dial(config) {
    if (++attempt === 1) throw new Error('synchronous failure');
    const socket = new FakeSocket(config); sockets.push(socket); return socket;
  } });
  f.start(); f.resolve(records);
  assert.equal(attempt, 2);
  assert.equal(f.time.pending, 2, 'exactly one deadline and one stagger timer');
  sockets[0].emit('secureConnect');
  assertFinished(f); f.time.tick(1000); assert.equal(attempt, 2);
});

test('all addresses fail with ordered AggregateError and single callback', (t) => {
  const f = fixture(t); f.start(); f.resolve();
  const errors = records.map((_, i) => new Error(`failure ${i}`));
  for (let i = 0; i < errors.length; i++) f.sockets[i].emit('error', errors[i]);
  assertFinished(f); assert.ok(f.calls[0][0] instanceof AggregateError);
  assert.deepEqual(f.calls[0][0].errors, errors);
  for (const socket of f.sockets) { assert.equal(socket.destroyed, true); socket.emit('error', new Error('duplicate')); socket.emit('secureConnect'); }
  assert.equal(f.calls.length, 1);
});

for (const result of [[], undefined, [{ address: 'invalid', family: 4 }], [{ address: '192.0.2.1', family: 6 }]]) {
  test(`DNS empty/invalid result ${JSON.stringify(result)} returns ENOTFOUND`, (t) => {
    const f = fixture(t); f.start();
    f.resolve(result);
    assertFinished(f, 'ENOTFOUND'); assert.equal(f.sockets.length, 0);
  });
}

test('DNS error is returned unchanged', (t) => {
  const f = fixture(t); const error = Object.assign(new Error('resolver failed'), { code: 'EAI_AGAIN' });
  f.start(); f.resolve([], error); assertFinished(f, 'EAI_AGAIN'); assert.equal(f.calls[0][0], error);
});

test('synchronous lookup throw is returned unchanged', (t) => {
  const error = new Error('lookup threw'); const f = fixture(t, { lookup() { throw error; } });
  f.start(); assertFinished(f); assert.equal(f.calls[0][0], error);
});

test('DNS hang consumes full deadline; late DNS success/error cannot dial or callback again', (t) => {
  const f = fixture(t); f.start(); f.time.tick(99); assert.equal(f.calls.length, 0);
  f.time.tick(1); assertFinished(f, 'UND_ERR_CONNECT_TIMEOUT');
  f.resolve(); f.resolve([], new Error('late DNS')); assert.equal(f.sockets.length, 0); assert.equal(f.calls.length, 1);
});

test('deadline includes DNS time and destroys all stalled sockets', (t) => {
  const f = fixture(t); f.start(); f.time.tick(60); f.resolve(); f.time.tick(39);
  assert.equal(f.sockets.length, 2); assert.equal(f.calls.length, 0);
  f.time.tick(1); assertFinished(f, 'UND_ERR_CONNECT_TIMEOUT');
  assert.ok(f.calls[0][0].cause instanceof AggregateError);
  for (const socket of f.sockets) { assert.equal(socket.destroyed, true); socket.emit('secureConnect'); socket.emit('error', new Error('late')); }
  assert.equal(f.calls.length, 1);
});

test('dispose cancels pending TLS and DNS connects exactly once, including late resolution', async (t) => {
  const f = fixture(t); f.start(); f.resolve(); f.time.tick(25); f.start();
  f.connect.dispose(); f.connect.dispose();
  assert.equal(f.calls.length, 2); assert.equal(f.reports.length, 2); assert.equal(f.time.pending, 0);
  for (const [error] of f.calls) assert.equal(error.code, 'UND_ERR_DESTROYED');
  for (const socket of f.sockets) assert.equal(socket.destroyed, true);
  f.resolve(); assert.equal(f.sockets.length, 2);
  f.start(); await Promise.resolve(); assert.equal(f.calls.length, 3); assert.match(f.calls[2][0].message, /disposed/);
});

test('unauthorized certificate cannot win; healthy next address can', (t) => {
  const f = fixture(t); f.start(); f.resolve();
  f.sockets[0].authorized = false; f.sockets[0].authorizationError = 'CERT_HAS_EXPIRED';
  f.sockets[0].emit('secureConnect'); assert.equal(f.calls.length, 0); assert.equal(f.sockets[0].destroyed, true);
  f.sockets[1].emit('secureConnect'); assertFinished(f); assert.equal(f.calls[0][1], f.sockets[1]);
});

test('all unauthorized certificates preserve verification error code', (t) => {
  const f = fixture(t); f.start(); f.resolve(records.slice(0, 1));
  f.sockets[0].authorized = false; f.sockets[0].emit('secureConnect');
  assertFinished(f); assert.equal(f.calls[0][0].errors[0].code, 'CERT_UNAUTHORIZED');
});

test('IPv6 dial retains original SNI, strict TLS, HTTP/1.1 and localAddress', (t) => {
  const f = fixture(t); f.start({ localAddress: '::1', rejectUnauthorized: false }); f.resolve([records[1]]);
  assert.deepEqual(f.lookups, [{ name: hostname, opts: { all: true, verbatim: true } }]);
  const { checkServerIdentity, ...config } = f.sockets[0].config;
  assert.equal(checkServerIdentity('ignored.test', { subjectaltname: `DNS:${hostname}` }), undefined);
  assert.equal(checkServerIdentity(hostname, { subjectaltname: 'DNS:other.test' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.deepEqual(config, { host: records[1].address, family: 6, port: 443, servername: hostname,
    localAddress: '::1', rejectUnauthorized: true, ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2', highWaterMark: 16384 });
  assert.equal(f.sockets[0].noDelay, true); assert.deepEqual(f.sockets[0].keepAlive, [true, 60000]);
  f.sockets[0].emit('secureConnect'); assertFinished(f);
});

test('DNS results are deduplicated, validated and capped at eight addresses', (t) => {
  const f = fixture(t); f.start();
  f.resolve([null, { address: 'bad', family: 4 }, records[0], records[0], ...Array.from({ length: 20 }, (_, i) => ({ address: `192.0.2.${i + 2}`, family: 4 }))]);
  for (let i = 0; i < 8; i++) f.sockets[i].emit('error', new Error('failed'));
  assertFinished(f); assert.equal(f.sockets.length, 8);
  assert.equal(new Set(f.sockets.map(s => s.config.host)).size, 8);
});

test('each connection performs a fresh lookup without cached address', (t) => {
  const f = fixture(t); f.start(); f.resolve([records[0]]); f.sockets[0].emit('secureConnect');
  f.start(); f.resolve([records[1]]); f.sockets[1].emit('secureConnect');
  assert.equal(f.lookups.length, 2); assert.equal(f.calls.length, 2); assert.equal(f.sockets[1].config.host, records[1].address);
});

test('diagnostic callback throwing cannot break successful handoff', (t) => {
  const f = fixture(t, { onResult() { throw new Error('diagnostic'); } });
  f.start(); f.resolve(); f.sockets[0].emit('secureConnect'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], null);
});

for (const extra of [{ hostname: 'evil.example.test' }, { protocol: 'http:' }, { port: 444 }, { httpSocket: {} }, { servername: 'other.test' }]) {
  test(`connector rejects out-of-scope options ${JSON.stringify(extra)}`, async (t) => {
    const f = fixture(t); f.start(extra); await Promise.resolve();
    assert.equal(f.calls.length, 1); assert.match(f.calls[0][0].message, /outside/);
    assert.equal(f.lookups.length, 0); assert.equal(f.time.pending, 0);
  });
}

test('invalid connection timing is rejected', () => {
  for (const config of [{ staggerMs: 0 }, { staggerMs: 1.5 }, { timeoutMs: 250 }, { timeoutMs: NaN }, { timeoutMs: 2 ** 31 }])
    assert.throws(() => createConnector({ hostname, ...config }), TypeError);
});

for (const value of [undefined, null, '', 42, 'bad name.test', 'https://example.test', 'example.test:443', '-bad.test', 'a..test', 'x'.repeat(64) + '.test', '192.0.2.1', '2001:db8::1', '[2001:db8::1]', '::1', '[::1]', '127.1', '2130706433', '0x7f000001']) {
  test(`constructor rejects missing, invalid or literal-IP hostname ${JSON.stringify(value)}`, () => {
    assert.throws(() => createConnector({ hostname: value }), TypeError);
  });
}

test('constructor requires explicit hostname and validates hooks and port', () => {
  assert.throws(() => createConnector(), TypeError);
  for (const port of [0, -1, 65536, 443.5, '443', NaN, null])
    assert.throws(() => createConnector({ hostname, port }), TypeError);
  for (const name of ['lookup', 'dial', 'onResult'])
    assert.throws(() => createConnector({ hostname, [name]: null }), TypeError);
  for (const name of ['localhost', 'api.example.test.', 'xn--bcher-kva.test']) createConnector({ hostname: name }).dispose();
});

test('custom HTTPS port is dialed and the default port is out of scope', async (t) => {
  const f = fixture(t, { port: 8443 });
  f.start(); await Promise.resolve();
  assert.match(f.calls[0][0].message, /outside/); assert.equal(f.lookups.length, 0);
  f.start({ port: '8443' }); f.resolve([records[0]]);
  assert.equal(f.sockets[0].config.port, 8443);
  assert.equal(f.sockets[0].config.servername, hostname);
  f.sockets[0].emit('secureConnect'); assert.equal(f.calls.length, 2); assert.equal(f.calls[1][0], null);
});

for (const port of ['', undefined, '443']) {
  test(`default HTTPS port accepts Undici representation ${JSON.stringify(port)}`, (t) => {
    const f = fixture(t); f.start({ port }); f.resolve([records[0]]);
    assert.equal(f.sockets[0].config.port, 443);
    f.sockets[0].emit('secureConnect'); assertFinished(f);
  });
}

test('default race stagger is 250ms and overall deadline is 10000ms', (t) => {
  const f = fixture(t, { staggerMs: undefined, timeoutMs: undefined });
  f.start(); f.time.tick(9000); f.resolve();
  f.time.tick(249); assert.equal(f.sockets.length, 1);
  f.time.tick(1); assert.equal(f.sockets.length, 2);
  f.time.tick(749); assert.equal(f.calls.length, 0);
  f.time.tick(1); assertFinished(f, 'UND_ERR_CONNECT_TIMEOUT');
  assert.ok(f.sockets.every(socket => socket.destroyed));
});

test('duplicate DNS callback cannot replace an active race', (t) => {
  const f = fixture(t); f.start(); f.resolve([records[0]]);
  f.resolve([records[1]]); f.resolve([], new Error('duplicate callback'));
  assert.equal(f.sockets.length, 1); assert.equal(f.calls.length, 0);
  f.sockets[0].emit('secureConnect'); assertFinished(f);
});

test('premature close advances immediately without requiring an error event', (t) => {
  const f = fixture(t); f.start(); f.resolve();
  f.sockets[0].emit('close'); assert.equal(f.sockets.length, 2);
  f.sockets[0].emit('error', new Error('late error'));
  assert.equal(f.sockets.length, 2);
  f.sockets[1].emit('secureConnect'); assertFinished(f);
});

test('equivalent IPv6 spellings are deduplicated and IPv6 DNS addresses remain supported', (t) => {
  const f = fixture(t); f.start();
  f.resolve([{ address: '2001:db8::2', family: 6 }, { address: '2001:0db8:0:0:0:0:0:2', family: 6 }]);
  f.sockets[0].emit('error', new Error('failed'));
  assertFinished(f); assert.equal(f.sockets.length, 1);
});

test('scoped IPv6 lookup addresses do not throw during deduplication', (t) => {
  const f = fixture(t); f.start(); f.resolve([{ address: 'fe80::1%en0', family: 6 }]);
  assert.equal(f.sockets[0].config.host, 'fe80::1%en0');
  f.sockets[0].emit('secureConnect'); assertFinished(f);
});

test('unsupported negotiated ALPN cannot win', (t) => {
  const f = fixture(t); f.start(); f.resolve([records[0]]);
  f.sockets[0].alpnProtocol = 'h2'; f.sockets[0].emit('secureConnect');
  assertFinished(f); assert.equal(f.calls[0][0].errors[0].code, 'ERR_TLS_ALPN_PROTOCOL');
  assert.equal(f.sockets[0].destroyed, true);
});

test('async diagnostic rejection cannot break transport', async (t) => {
  const f = fixture(t, { async onResult() { throw new Error('diagnostic rejection'); } });
  f.start(); f.resolve(); f.sockets[0].emit('secureConnect');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], null); assert.equal(f.time.pending, 0);
});

test('diagnostic exception cannot break error completion', (t) => {
  const f = fixture(t, { onResult() { throw new Error('diagnostic'); } });
  f.start(); f.time.tick(100);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0].code, 'UND_ERR_CONNECT_TIMEOUT');
});

test('synchronous failures of all candidates leave no timers', (t) => {
  const f = fixture(t, { dial() { throw new Error('dial throw'); } });
  f.start(); f.resolve(); assertFinished(f);
  assert.equal(f.calls[0][0].errors.length, 3);
});

test('pending race cancellation is isolated from completed sockets and concurrent race', (t) => {
  const f = fixture(t); f.start(); f.resolve([records[0]]);
  f.start(); f.resolve([records[1]]);
  f.sockets[0].emit('secureConnect'); assert.equal(f.calls.length, 1);
  assert.equal(f.sockets[1].destroyed, false);
  f.connect.dispose(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1][0].code, 'UND_ERR_DESTROYED');
  assert.equal(f.sockets[0].destroyed, false); assert.equal(f.sockets[1].destroyed, true);
  assert.equal(f.time.pending, 0);
});
