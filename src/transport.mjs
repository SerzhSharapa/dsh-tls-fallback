import net from 'node:net';
import { createConnector } from './connector.mjs';

const marker = Symbol.for('dsh-tls-fallback.transport');

export function eligibleOrigin(origin) {
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const name = host.endsWith('.') ? host.slice(0, -1) : host;
    if (url.protocol !== 'https:' || !name || host.length > 253 || net.isIP(host) || url.username || url.password ||
        Number(url.port || 443) < 1 || !name.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) return null;
    return url;
  } catch { return null; }
}

/** The global hook routes only selected provider-scoped, direct HTTPS calls. */
export function installTransport({ undici, proxyRouteFor, currentScope, config,
  connectorFactory = createConnector, onResult = () => {} }) {
  if (globalThis[marker]) throw new Error('dsh-tls-fallback already active');
  const previous = undici.getGlobalDispatcher();
  const connectors = new Set();
  const agent = new undici.Agent({ connections: 4, pipelining: 1,
    factory(origin, options) {
      const url = eligibleOrigin(origin);
      if (!url) throw new Error('Non-HTTPS/DNS origin reached TLS fallback pool');
      const connector = connectorFactory({ hostname: url.hostname, port: Number(url.port || 443),
        staggerMs: config.staggerMs, timeoutMs: config.timeoutMs,
        onResult: result => onResult({ ...result, hostname: url.hostname }),
      });
      connectors.add(connector);
      return new undici.Pool(origin, { ...options, connect: connector });
    },
  });
  let disposed = false;
  let closing;
  function detach() {
    if (disposed) return;
    disposed = true;
    if (undici.getGlobalDispatcher() === routed) undici.setGlobalDispatcher(previous);
    if (globalThis[marker] === routed) delete globalThis[marker];
  }
  function destroy(error) {
    detach();
    for (const connector of connectors) connector.dispose();
    connectors.clear();
    return agent.destroy(error);
  }
  const routed = {
    dispatch(options, handler) {
      const provider = currentScope()?.provider;
      if (disposed || !config.enabled || !provider || !config.providers.includes(provider)) {
        return previous.dispatch(options, handler);
      }
      const url = eligibleOrigin(options.origin);
      if (!url || proxyRouteFor(url).proxied) return previous.dispatch(options, handler);
      return agent.dispatch(options, handler);
    },
    close(callback) {
      detach();
      closing ??= agent.close();
      if (callback) { closing.then(() => callback(null), callback); return; }
      return closing;
    },
    destroy(error, callback) {
      if (typeof error === 'function') { callback = error; error = undefined; }
      const promise = destroy(error);
      if (callback) { promise.then(() => callback(null), callback); return; }
      return promise;
    },
  };
  try { undici.setGlobalDispatcher(routed); globalThis[marker] = routed; }
  catch (error) { void destroy(error); throw error; }
  let disposal;
  return Object.assign(() => disposal ??= destroy(), {
    isActive: () => !disposed && undici.getGlobalDispatcher() === routed,
  });
}
