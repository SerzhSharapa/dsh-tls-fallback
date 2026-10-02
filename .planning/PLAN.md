# Phase 01 plan

## 1. Generalize connection logic

A HTTPS DNS-origin connector with hostname+port, fresh DNS, strict SNI/certificate verification, bounded 8-address handshakes, disposal and no HTTP duplication. Unit tests for failure/timeout/cancellation/security edge cases.

## 2. Provider scope and native settings

Use the supported llm/stream waterfall plus AsyncLocalStorage on iterator creation/next/return/throw. Always scope calls, even unselected ones, so nested calls cannot inherit selection. Global undici dispatcher routes only selected provider scopes with direct HTTPS DNS origins; everything else delegates unchanged. Native .volatile Config enabled/providers persists through configForms. Custom small settings.section client is necessary: this DSH version has no auto-rendered schema settings page. Use host React and controls, not a replacement server.

## 3. Packaging and verification

Standard DSH bundle patch and client module-loader asset. Host services peer-declared, undici8 matches host dispatcher ABI. No absolute runtime paths. Verify package peers route to built-in proxy singleton. Test real TLS blackhole/healthy fixtures, provider isolation on shared origin, TLS trust and hostname rejection, cancellation and cleanup. Build client, validate emitted artifact and tarball, verify running desktop installation/GUI where access is available.

## 4. Documentation and release

Use readme-skill fact ledger and full in-conversation EN/RU/zh-CN drafts before writing. Centered header, verified static runtime/license badges, ASCII, Quick Start. MIT. GitHub public repository owner explicitly confirmed. Audit all tracked files for credentials/private runtime paths and large/extracted artifacts, run CI/release checks. Publish tag and installable tarball. Replace local-only fix atomically after validation, with rollback backup. Update HQ deployment notes separately; never publish personal profile snapshots.
