import * as undici from 'undici';
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy';
import { Config, liveConfig } from './config.mjs';
import { createProviderScope } from './scope.mjs';
import { installTransport } from './transport.mjs';

export { Config };
export const name = 'dsh-tls-fallback';
export const inject = ['llm'];

export function apply(ctx, config) {
  const scope = createProviderScope();
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  ctx.effect(() => installTransport({ undici, proxyRouteFor,
    currentScope: scope.current, config: liveConfig(config) }));
  ctx.on('llm/stream', (options, next) => scope.wrap(options, next), { global: true });
}
