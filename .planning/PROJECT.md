# dsh-tls-fallback

## Goal

A standalone DeepSeek Harness plugin that races verified TLS connections across current DNS addresses for user-selected LLM providers. It avoids fixed IPs, respects the host proxy policy, and never races or retries HTTP requests.

## Publication

Публикация: открытый GitHub, MIT — explicitly approved by the owner on 2026-10-02.
Repository: https://github.com/SerzhSharapa/dsh-tls-fallback (public repository created).
README languages: English primary, Russian, Simplified Chinese. Centered header, verified badges, ASCII architecture, Quick Start. No imagery, usage showcase, or Star History.

## Scope

- Standard installable DSH bundle, sibling of dsh-stt-multi.
- Native settings page with persistent provider selection and enable switch.
- Provider-level isolation, including when selected/unselected providers share an endpoint.
- Dynamic DNS, strict TLS verification, bounded handshake racing, proxy preservation.
- Unit/integration tests, package/install verification, public safety audit, release tarball.
- Migrate the existing local fix only after the replacement is verified; preserve rollback.

## Out of scope

System DNS/hosts/proxy changes, disabling certificate verification, replacing the user's model or credentials, app ASAR patches, native WebSocket interception, replaying model POST requests, npm publication unless separately requested.

## Workflow

GSD-style scoped phase: research → plan → implementation → independent review → verification. The gsd-quick skill is unavailable in the current DSH skill registry; existing global installations are read-only and are not reinstalled. State and evidence are recorded locally in .planning rather than claiming an unavailable skill ran.

## Acceptance

Selecting providers affects only their calls; disabled/empty selection is no-op. Settings survive restart. Default selection is empty in the published bundle; the local installation explicitly selects zai-coding-cn. Other providers and proxy routes are unchanged. Public package contains no host-specific paths, IPs, secrets, status snapshots, or extracted DSH code.
