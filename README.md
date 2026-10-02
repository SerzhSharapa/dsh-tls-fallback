<h1 align="center">DSH TLS Fallback</h1>

<p align="center"><img src="./assets/readme-hero.svg" width="960" alt="Protected connection with an available fallback route"></p>

<p align="center">Provider-selectable TLS connection fallback for DeepSeek Harness — without fixed IPs.</p>

<p align="center"><a href="./README.md">English</a> · <a href="./README.ru-RU.md">Русский</a> · <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center"><a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue?style=flat-square"></a> <a href="https://nodejs.org/"><img alt="Node.js >=22.19" src="https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?style=flat-square"></a></p>

## Highlights

A DNS address can accept TCP while its TLS handshake stalls. This plugin tries other current DNS addresses without pinning an IP or replaying the model request.

- Select affected LLM providers in native DSH Settings.
- Providers remain isolated even when they share an endpoint.
- Fresh DNS for each new connection; staggered TLS attempts.
- Original hostname, SNI and certificate verification are preserved.
- Proxied and unselected traffic keeps the previous transport.

Targets **DSH 0.2.0-rc.2**, with Node.js **22.19+**.

## Architecture

```text
┌────────────┐    ┌───────────────────┐
│ LLM stream │───▶│ Provider + policy │
└────────────┘    └─────────┬─────────┘
                           ├── bypass ──▶ Previous dispatcher
                           └── direct ──▶ DNS ──▶ TLS race ──▶ HTTP
```

Only selected provider scopes using direct HTTPS through the global Node fetch/undici dispatcher enter the TLS race. HTTP is sent through the winning connection.

## Quick Install

1. Download `dsh-tls-fallback-0.1.0.tgz` from [Releases](https://github.com/SerzhSharapa/dsh-tls-fallback/releases).
2. In DSH, open **Plugins → Add plugin**, enter the archive's absolute local path, and install.
3. Restart DSH if requested, then refresh the interface.

Use the `.tgz` package, not GitHub's “Source code” archive. No npm-registry publication is required.

## Quick Start

1. Open **Settings → TLS connection fallback**.
2. Leave the switch enabled and select the provider experiencing connection timeouts.
3. Send a normal message through that provider.

Changes save automatically. No providers are selected by default, so a fresh installation changes no traffic. Unselect a provider or turn off the switch to bypass this plugin for subsequent requests.

![Native DSH settings with GLM selected](./assets/settings.png)

*Actual DSH settings in Russian, with GLM selected. Cropped; the custom provider name is redacted.*

## Scope and limits

- Defaults: 250 ms between attempts, a 10-second DNS/TLS deadline, up to 8 addresses.
- No fixed IPs, OS networking changes, credential changes or HTTP retries.
- HTTP, IP-literal origins, proxied requests, out-of-scope calls and WebSocket transports are not handled by this fallback.
- Adapters with their own dispatcher or non-Node transport may bypass the plugin.
- It does not fix invalid credentials, rate limits, HTTP server errors or slow model generation.
- Request cancellation returns promptly; pending connection attempts may remain until their deadline or plugin disposal.
- Do not run an older independent TLS fallback simultaneously: it may still affect providers unselected here.

## Development

```bash
git clone https://github.com/SerzhSharapa/dsh-tls-fallback.git
cd dsh-tls-fallback
npm ci --ignore-scripts
npm test
npm pack
```

`npm pack` builds the client bundle. Tests include provider isolation and real local TLS fixtures; integration tests require OpenSSL. Install the resulting archive through DSH's plugin manager.

## License

[MIT](./LICENSE).
