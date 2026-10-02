import dns from 'node:dns';
import tls from 'node:tls';
import net from 'node:net';

function validHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length > 253 || net.isIP(hostname)) return false;
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (!name || !name.split('.').every(label =>
    /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) return false;
  // Reject alternative IPv4 spellings too (e.g. decimal, octal, shortened).
  try { return !net.isIP(new URL(`https://${hostname}`).hostname); } catch { return false; }
}

/**
 * Race TLS handshakes only, never HTTP requests. Resolve afresh for every connect.
 * One connector is scoped to a single HTTPS DNS origin; IP origins must bypass it.
 * lookup/dial are injectable for testing; production uses native Node transports.
 */
export function createConnector({
  hostname, port = 443, staggerMs = 250, timeoutMs = 10_000,
  lookup = dns.lookup, dial = tls.connect, onResult = () => {},
} = {}) {
  if (!validHostname(hostname)) throw new TypeError('hostname must be a DNS hostname, not an IP literal');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid HTTPS port');
  if (!Number.isInteger(staggerMs) || staggerMs < 1 ||
      !Number.isInteger(timeoutMs) || timeoutMs <= staggerMs || timeoutMs > 2 ** 31 - 1) {
    throw new TypeError('Invalid connection timing');
  }
  if (typeof lookup !== 'function' || typeof dial !== 'function' || typeof onResult !== 'function') {
    throw new TypeError('lookup, dial and onResult must be functions');
  }
  let disposed = false;
  const pending = new Set();
  const disposedError = () => Object.assign(new Error('TLS fallback connector disposed'), { code: 'UND_ERR_DESTROYED' });
  function connect(options, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (disposed) return queueMicrotask(() => callback(disposedError()));
    if (!options || options.hostname !== hostname || options.protocol !== 'https:' ||
        Number(options.port === '' || options.port == null ? 443 : options.port) !== port || options.httpSocket ||
        (options.servername && options.servername !== hostname)) {
      return queueMicrotask(() => callback(new Error('Origin outside TLS fallback scope')));
    }
    let done = false;
    let resolved = false;
    let next = 0;
    let addresses = [];
    let timer;
    const sockets = new Set();
    const errors = [];
    const started = Date.now();
    function report(result) {
      try {
        // A rejected async diagnostic must not become an unhandled rejection.
        Promise.resolve(onResult(result)).catch(() => {});
      } catch { /* diagnostics cannot break transport */ }
    }
    function finish(error, winner) {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(timer);
      pending.delete(cancel);
      for (const socket of sockets) if (socket !== winner) socket.destroy();
      sockets.clear();
      report({ ok: !error, attempts: next, durationMs: Date.now() - started,
        code: error?.code, address: winner?.remoteAddress });
      callback(error, winner);
    }
    function cancel() { finish(disposedError()); }
    const deadline = setTimeout(() => {
      const error = new Error(`TLS connection to ${hostname}:${port} timed out after ${timeoutMs}ms`);
      error.code = 'UND_ERR_CONNECT_TIMEOUT';
      error.cause = new AggregateError(errors, 'TLS address attempts');
      finish(error);
    }, timeoutMs);
    pending.add(cancel);
    function launch() {
      clearTimeout(timer);
      if (done || next >= addresses.length) return;
      const { address, family } = addresses[next++];
      let socket;
      let failedAlready = false;
      const failed = (error) => {
        if (done || failedAlready) return;
        failedAlready = true;
        if (socket) { sockets.delete(socket); socket.destroy(); }
        errors.push(error);
        if (next < addresses.length) launch();
        else if (sockets.size === 0) finish(new AggregateError(errors, `All TLS addresses failed for ${hostname}:${port}`));
      };
      try {
        socket = dial({ host: address, family, port, servername: hostname,
          localAddress: options.localAddress, rejectUnauthorized: true,
          checkServerIdentity: (_host, cert) => tls.checkServerIdentity(hostname, cert),
          ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2', highWaterMark: 16384 });
        sockets.add(socket);
        // Retain the error listener: destroyed losers can emit late errors.
        socket.on('error', failed);
        socket.once('close', () => {
          const error = Object.assign(new Error('TLS socket closed before handshake'), { code: 'ECONNRESET' });
          failed(error);
        });
        socket.once('secureConnect', () => {
          if (done || failedAlready) { socket.destroy(); return; }
          if (!socket.authorized) {
            const error = new Error('TLS certificate verification failed');
            error.code = socket.authorizationError || 'CERT_UNAUTHORIZED';
            failed(error);
            return;
          }
          if (socket.alpnProtocol && socket.alpnProtocol !== 'http/1.1') {
            failed(Object.assign(new Error('Unexpected negotiated ALPN protocol'), { code: 'ERR_TLS_ALPN_PROTOCOL' }));
            return;
          }
          finish(null, socket);
        });
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 60_000);
      } catch (error) { failed(error); }
      if (!done && next < addresses.length) {
        clearTimeout(timer);
        timer = setTimeout(launch, staggerMs);
      }
    }
    try {
      lookup(hostname, { all: true, verbatim: true }, (error, result) => {
        if (done || resolved) return;
        resolved = true;
        if (error) return finish(error);
        const seen = new Set();
        addresses = [];
        for (const entry of Array.isArray(result) ? result : []) {
          if (!entry || ![4, 6].includes(entry.family) || net.isIP(entry.address) !== entry.family) continue;
          const [ip, zone = ''] = entry.address.split('%');
          const key = entry.family === 6 ? `${new URL(`http://[${ip}]/`).hostname}%${zone}` : entry.address;
          if (seen.has(key)) continue;
          seen.add(key);
          addresses.push({ address: entry.address, family: entry.family });
          if (addresses.length === 8) break;
        }
        if (!addresses.length) {
          const empty = new Error(`DNS returned no addresses for ${hostname}`);
          empty.code = 'ENOTFOUND';
          return finish(empty);
        }
        launch();
      });
    } catch (error) { finish(error); }
  }
  connect.dispose = () => {
    disposed = true;
    for (const cancel of [...pending]) cancel();
  };
  return connect;
}
