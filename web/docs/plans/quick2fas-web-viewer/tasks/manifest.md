# Quick2FAS Web Viewer — Task Manifest

## Overview

Self-contained task documents for building the Quick2FAS Web Viewer: a zero-backend static web app
that imports a 2FAS Auth backup file in the browser and renders live TOTP codes. Scope covers the
toolchain skeleton, the crypto/parse library, the IndexedDB vault, and the read-only UI.

**Toolchain note:** the repository is empty at plan time (only `2526173 Initial commit`, zero tracked
files). No `package.json` exists yet, so no toolchain could be detected — **T01 creates it**, and
every command below is the one T01 is required to make real, exactly as fixed by the design (§6 of
`../design.md`). All later tasks are verified against those commands.

## Task List

This table is the **autonomously executable** task set — the machine-readable source of truth for
`/run-tasks`. `manual` tasks are **not** listed here; they appear under *Manual / Out-of-Band Tasks*.

Task IDs are `T0n`; the design letter follows in parentheses: **T01 = A**, **T02 = B**, **T03 = C**,
**T04 = D**. Design item **E** is not an auto task — its acceptance is inherently manual (offline
reload, network-panel inspection), so its configuration/documentation half was folded into T01 and
its verification half became **M01**.

| ID | Task | Depends | Description |
|----|------|---------|-------------|
| T01 | [01-project-skeleton.md](./01-project-skeleton.md) | — | (A + E-config) Vite/React/TS/Tailwind/PWA skeleton with CSP, test env, and README |
| T02 | [02-crypto-and-parse-lib.md](./02-crypto-and-parse-lib.md) | T01 | (B) Base32, RFC 6238 TOTP, and 2FAS backup decrypt/parse/normalise, unit-tested |
| T03 | [03-vault-store.md](./03-vault-store.md) | T01, T02 | (C) IndexedDB vault encrypted under a non-extractable key, replace-all/erase/settings |
| T04 | [04-viewer-ui.md](./04-viewer-ui.md) | T02, T03 | (D) Import flow, live token list with countdown/copy/search, unsupported badges, settings |

## Dependency Graph

```
T01/A (Skeleton)
 │
 ├──→ T02/B (Crypto + Parse Lib)
 │      │
 └──────┴──→ T03/C (Vault Store)
               │
        T02/B ─┴──→ T04/D (Viewer UI)
```

### Execution Order

**Wave 1** (no dependencies):
1. **T01/A** — Project skeleton

**Wave 2** (depends on Wave 1):
2. **T02/B** — Crypto and parse library

**Wave 3** (depends on T01, T02):
3. **T03/C** — Vault store

**Wave 4** (depends on T02, T03):
4. **T04/D** — Viewer UI

The graph is serial because every layer consumes the layer below it (design §3.1); there is no
parallelism to recover without inventing a contract that exists only to split a task.

## Shared Contracts

Frozen interfaces crossing task boundaries. The **owner** is the single source of truth; every
consumer copies the exact form verbatim. Mirrors §4 of `../design.md`.

| Contract | Owner | Form (verbatim) | Consumers | Canonical example / fixture |
|----------|-------|-----------------|-----------|------------------------------|
| `ServiceEntry` | T02 | `type TokenType = 'TOTP' \| 'HOTP' \| 'STEAM' \| 'UNKNOWN';`<br>`type OtpAlgorithm = 'SHA1' \| 'SHA256' \| 'SHA512';`<br>`interface ServiceEntry { id: string; name: string; issuer: string \| null; account: string \| null; secret: string; algorithm: OtpAlgorithm; digits: number; period: number; tokenType: TokenType; unsupportedReason: string \| null; }` | T03, T04 | One SHA1/6/30 TOTP entry + one `tokenType: 'HOTP'` entry with `unsupportedReason` set |
| Backup import | T02 | `interface ParsedBackup { entries: ServiceEntry[]; schemaVersion: number; wasEncrypted: boolean; }`<br>`function isEncryptedBackup(raw: unknown): boolean;`<br>`function parseBackup(raw: unknown, password?: string): Promise<ParsedBackup>;` | T04 | Synthetic plaintext + synthetic encrypted backup generated in-test |
| Import errors | T02 | `type ImportErrorCode = 'INVALID_JSON' \| 'UNSUPPORTED_SCHEMA' \| 'NOT_A_BACKUP' \| 'PASSWORD_REQUIRED' \| 'WRONG_PASSWORD' \| 'DECRYPT_FAILED';`<br>`class ImportError extends Error { readonly code: ImportErrorCode; }` | T04 | `WRONG_PASSWORD` from a good file + bad password |
| TOTP | T02 | `function generateTotp(entry: ServiceEntry, atMs: number): Promise<string>;`<br>`function periodProgress(entry: ServiceEntry, atMs: number): { remainingSec: number; fraction: number };` | T04 | RFC 6238: 20-byte ASCII seed `12345678901234567890`, SHA1, 8 digits, t=59s → `94287082` |
| Base32 | T02 | `function base32Decode(input: string): Uint8Array;` | T02 (totp) | RFC 4648 vectors |
| Vault store | T03 | `interface VaultStore { load(): Promise<ServiceEntry[]>; replaceAll(entries: ServiceEntry[]): Promise<void>; erase(): Promise<void>; }`<br>`interface SettingsStore { getClockOffsetSec(): Promise<number>; setClockOffsetSec(sec: number): Promise<void>; }` | T04 | `replaceAll` twice → the second call's entries are the only ones `load` returns |
| npm scripts | T01 | `dev`, `build`, `preview`, `lint`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`) | T02, T03, T04 | `npm run typecheck` exits 0 on the skeleton |

## Manual / Out-of-Band Tasks

Not executable by an unattended worker. `/run-tasks` must never run these.

| ID | Task | After | Why manual |
|----|------|-------|------------|
| M01 | Build the app, serve `dist/`, load it once, then go offline and reload: codes must still render; the DevTools network panel must show **no** third-party or runtime requests, and no CSP violations in the console (design D11, D14; realizes design item E's verification half) | T04 | Requires a human looking at a running browser, its network panel, and offline mode |
| M02 | Import a **real** `.2fas` backup (both a plaintext and an officially encrypted one) exported from the 2FAS app, and confirm decryption succeeds and the codes match what the phone shows (design D6) | T04 | Requires a real secret-bearing file that must never enter the repo (D17), plus a phone-side comparison |

M02 is the acceptance evidence for **D6**: T02's tests prove internal round-trip consistency against
synthetic fixtures, which cannot by itself prove the upstream 2FAS parameters were guessed right.

## Validation Commands

Repo-wide gate. `/run-tasks` runs these once before the first task (baseline) and once after the
last; the run passes on **no new failures vs baseline**. They will fail at baseline (no
`package.json` exists yet) — that is expected and is exactly what the delta gate absorbs.

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Test Runners

Single package at the repo root; test-file paths are passed as trailing args.

```
.: npx vitest run
```

## Worktree Setup

Idempotent; a no-op in a worktree where `package.json` does not exist yet (before T01 lands).

```bash
npm install --no-audit --no-fund
```

## Commit Excludes

T01 explicitly names `package-lock.json` in its scope, so the default Node-lockfile exclusion must
not apply to it. No additional excludes.

## Required Permissions

```json
[
  "Bash(npm install *)",
  "Bash(npm run *)",
  "Bash(npm test *)",
  "Bash(npx vitest *)",
  "Bash(npx tsc *)",
  "Bash(npx eslint *)",
  "Bash(mkdir *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(grep *)",
  "Write(*)",
  "Edit(*)"
]
```

## Acceptance Rule

**Every task must pass its specified tests/checks before being considered complete.** Each task
document specifies the test files to create, the test cases to implement, and the exact commands
that must pass.

## Design Documents

- [../design.md](../design.md) — primary design (frozen Decisions D1–D20, file-level plan, contracts)
