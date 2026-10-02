import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import * as undici from 'undici';
import { createConnector } from '../src/connector.mjs';
import { createProviderScope } from '../src/scope.mjs';
import { installTransport } from '../src/transport.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsh-tls-test-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'),
  '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=example.test',
  '-addext', 'subjectAltName=DNS:example.test'], { stdio: 'ignore' });
const key = readFileSync(join(dir, 'key.pem'));
const cert = readFileSync(join(dir, 'cert.pem'));
async function fixture() {
  const sockets = new Set();
  const requests = [];
  const names = [];
  const blackhole = net.createServer();
  const server = https.createServer({ key, cert }, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, host: req.headers.host, body });
    res.end('tls-ok');
  });
  server.on('secureConnection', socket => names.push(socket.servername));
  for (const s of [blackhole, server]) {
    s.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  }
  return { requests, names, port: server.address().port,
    dial: opts => tls.connect({ ...opts, ca: cert, host: '127.0.0.1',
      port: opts.host === '127.0.0.1' ? blackhole.address().port : server.address().port }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([blackhole, server].map(s => new Promise(resolve => s.close(resolve))));
    },
  };
}
const lookup = (_h, _o, cb) => queueMicrotask(() => cb(null, [
  { address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 },
]));
async function inScope(scope, provider, action) {
  for await (const value of scope.wrap({ provider }, async function* () { yield await action(); })) return value;
}

test('selected provider races real TLS; unselected provider on same origin uses previous transport', async () => {
  const f = await fixture();
  const original = undici.getGlobalDispatcher();
  const mock = new undici.MockAgent(); mock.disableNetConnect();
  mock.get('https://example.test').intercept({ path: '/', method: 'POST' }).reply(200, 'plain');
  undici.setGlobalDispatcher(mock);
  const scope = createProviderScope();
  const results = [];
  const dispose = installTransport({ undici, proxyRouteFor: () => ({ proxied: false }), currentScope: scope.current,
    config: { enabled: true, providers: ['selected'], staggerMs: 25, timeoutMs: 1000 },
    onResult: result => results.push(result),
    connectorFactory: opts => createConnector({ ...opts, lookup, dial: f.dial }),
  });
  try {
    const request = body => fetch('https://example.test/', { method: 'POST', body, signal: AbortSignal.timeout(3000) }).then(r => r.text());
    const [selected, unselected] = await Promise.all([
      inScope(scope, 'selected', () => request('single-post')),
      inScope(scope, 'unselected', () => request('previous-post')),
    ]);
    assert.equal(selected, 'tls-ok'); assert.equal(unselected, 'plain');
    assert.deepEqual(f.requests, [{ method: 'POST', host: 'example.test', body: 'single-post' }]);
    assert.deepEqual(f.names, ['example.test']);
    assert.equal(results[0].attempts, 2); assert.equal(results[0].ok, true);
    assert.equal(scope.current(), undefined);
  } finally { await dispose(); await mock.close(); undici.setGlobalDispatcher(original); await f.close(); }
});

test('abort before handshake sends no POST, caller returns before connection deadline', async () => {
  const f = await fixture();
  const scope = createProviderScope();
  const dispose = installTransport({ undici, currentScope: scope.current, proxyRouteFor: () => ({ proxied: false }),
    config: { enabled: true, providers: ['selected'], staggerMs: 100, timeoutMs: 300 },
    connectorFactory: opts => createConnector({ ...opts, dial: f.dial,
      lookup: (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) }),
  });
  try {
    const start = Date.now();
    await assert.rejects(inScope(scope, 'selected', () => fetch('https://example.test/',
      { method: 'POST', body: 'never', signal: AbortSignal.timeout(30) })), /timeout|abort/i);
    assert.ok(Date.now() - start < 300);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(f.requests.length, 0);
  } finally { await dispose(); await f.close(); }
});

for (const trusted of [false, true]) {
  test(trusted ? 'trusted certificate for wrong hostname is rejected' : 'untrusted certificate is rejected', async () => {
    const f = await fixture(); const scope = createProviderScope();
    const dispose = installTransport({ undici, currentScope: scope.current, proxyRouteFor: () => ({ proxied: false }),
      config: { enabled: true, providers: ['selected'], staggerMs: 25, timeoutMs: 1000 },
      connectorFactory: opts => createConnector({ ...opts,
        lookup: (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
        dial: opts => tls.connect({ ...opts, ...(trusted ? { ca: cert } : {}), host: '127.0.0.1', port: f.port }),
      }),
    });
    try {
      await assert.rejects(inScope(scope, 'selected', () => fetch(trusted ? 'https://wrong.test/' : 'https://example.test/',
        { signal: AbortSignal.timeout(3000) })), error => {
          assert.match(String(error.cause?.errors?.[0]?.code), /SELF_SIGNED|CERT/); return true;
        });
      assert.equal(f.requests.length, 0);
    } finally { await dispose(); await f.close(); }
  });
}
