import Schema from '@deepseek-ai/schemastery';

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  providers: Schema.array(Schema.string().min(1)).default([]).volatile(),
  staggerMs: Schema.natural().min(50).max(2000).default(250),
  timeoutMs: Schema.natural().min(2500).max(60000).default(10000),
});

export function liveConfig(config) {
  return {
    get enabled() { return config.enabled.get(); },
    get providers() { return config.providers.get(); },
    staggerMs: config.staggerMs,
    timeoutMs: config.timeoutMs,
  };
}
