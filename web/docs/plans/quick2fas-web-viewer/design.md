# Quick2FAS Web Viewer — Design

> §2 Decisions is **normative and frozen**: it changes only by explicit user sign-off.
> All other sections cite decisions as (D<n>) and MUST NOT restate their content.

## Summary

A zero-backend, static web app that imports a 2FAS Auth backup file (`.2fas` / JSON, plaintext or
encrypted) entirely in the browser and renders live TOTP codes, so the owner can read their second
factor without reaching for a phone. Decryption (PBKDF2-SHA256 + AES-256-GCM) and code generation
(RFC 6238 over WebCrypto HMAC) run client-side; entries persist in IndexedDB; multi-device use is
achieved by re-importing the same backup file rather than by any server or sync protocol.

## 1. Problem & Context

Reading a TOTP code today requires unlocking a phone and opening the 2FAS Auth app. That fails
exactly when it is most annoying — phone in another room, battery dead, or hands already on the
keyboard mid-login. The owner wants the same codes available in a browser tab.

**Current state of this repository:** empty. `git ls-files` returns nothing; the only commit is
`2526173 Initial commit`. There is no `CLAUDE.md`, `AGENTS.md`, `README.md`, `package.json`, or any
source file. Every path named in §3 is therefore new, and there are no existing conventions,
utilities, or prior art to reuse — the stack in (D14) is chosen fresh rather than inherited.

**Security posture, stated once here as context for (D10)/(D11):** moving TOTP seeds into a browser
collapses the phone-vs-computer separation that makes 2FA a *second* factor. Anyone with code
execution on the app's origin (XSS), or with hands on an already-open browser profile, can read every
seed. The at-rest encryption in (D10) raises the bar against offline scraping of the browser data
directory only. This trade-off was explicitly accepted by the owner in favour of zero-friction
access; the design's job is to keep the blast radius as small as the choice allows (D11, D12).

**Upstream format reference:** the 2FAS backup schema and its encryption scheme are defined by the
open-source 2FAS Auth mobile apps (`twofas/android`, `twofas/ios`). The concrete parameters relied on
by (D5) must be reconciled against that source and a real backup file during implementation (D6).

## 2. Decisions (FROZEN)

### Scope & data flow

- **D1** — The only supported data entry path is importing a 2FAS Auth backup file (`.2fas` or
  `.json`) chosen from disk or dropped onto the page. No QR scanning, no camera, no manual secret
  entry, no `otpauth://` / `otpauth-migration://` URI paste.
- **D2** *(amended 2026-08-13 by owner sign-off — see D2-history below)* — The app does not
  **author** entry content: no create, no edit, no rename, no grouping. It does allow the owner to
  curate the imported list: search/filter, **per-entry delete**, and **manual reorder** (persisted),
  plus the global "erase all local data" action. Nothing in this decision permits changing a
  stored entry's secret, issuer, account, or algorithm parameters — the backup file remains the sole
  authority on entry *content* (D1, D4).

  **D2-history** — Originally frozen as: *"The app is read-only over its entries: no create, edit,
  rename, reorder, grouping, or per-entry delete."* Amended on 2026-08-13 at the owner's explicit
  request to add per-entry delete and drag-to-reorder. Rationale: with a real backup imported, a
  read-only list proved impractical to live with — stale entries could only be removed by editing
  the backup on the phone and re-importing, which D3 makes destructive for everything else. The
  prohibition on *authoring* content is unchanged and remains the substance of this decision; only
  curation of an already-imported list was opened up.

  **Ordering.** Display order is a property of the local vault, not of an entry (it is therefore not
  part of the D7 record). It is stored per record *outside* the ciphertext, so reordering needs
  neither the wrapping key nor re-encryption; order is not a secret, since record ids are already
  stored in the clear under (D10). A fresh import assigns order from the backup file's own sequence.
  Records written before this amendment carry no order and fall back to their storage-key sequence.
- **D3** — A successful import **replaces** the entire local vault. Prior entries are discarded; no
  merge, no de-duplication, no conflict resolution. The import dialog states this before committing
  the replacement.
- **D4** — Multi-device access is achieved by importing the same backup file on each device. The app
  produces no export file of any kind and performs no synchronisation.

### Backup parsing & decryption

- **D5** — Both plaintext backups (`services[]` populated) and officially encrypted backups
  (`servicesEncrypted` populated) are supported, for `schemaVersion` 2 through 4. An encrypted
  backup prompts for the backup password; the key is derived with PBKDF2-SHA256 and the payload is
  decrypted with AES-256-GCM, matching the upstream 2FAS scheme. Password correctness is verified by
  decrypting the backup's `reference` field and comparing it to the known 2FAS reference constant
  **before** any entry is written to storage; a mismatch is reported as "wrong password" and changes
  nothing.
- **D6** — The exact upstream constants (PBKDF2 iteration count, hash, salt/IV lengths, the
  `servicesEncrypted` field delimiter and part order, and the `reference` plaintext constant) are
  **verified against the 2FAS open-source implementation and a real backup file during
  implementation**, not assumed from this document. §4 records the shapes the code must expose; the
  numeric parameters are an implementation-time verification obligation, and a synthetic fixture
  round-trip (D17) is the acceptance evidence.
- **D7** — Each parsed entry is normalised to a single internal record carrying: stable id, issuer,
  account label, display name, Base32 secret, algorithm, digit count, period, and token type.
  Fields absent from a backup fall back to the OTP defaults: SHA1, 6 digits, 30-second period.
- **D8** — A file that is not valid JSON, lacks a recognised `schemaVersion`, or contains neither
  `services` nor `servicesEncrypted` is rejected with a specific, human-readable error naming which
  check failed. A parse or decrypt failure never partially writes the vault and never blanks the UI.
- **D9** — Import is tolerant per entry: an individual malformed entry (unparseable secret,
  unrecognised algorithm) does not abort the import. It is stored and listed in an explicit
  "unsupported" state (see D13) alongside the reason.

### Storage & security

- **D10** — There is no unlock password and no lock screen. The vault is readable immediately on page
  load. Entries are nevertheless stored in IndexedDB encrypted under an AES-GCM key generated with
  `extractable: false` and held in IndexedDB as a `CryptoKey` handle, so that seeds are not
  recoverable by reading the browser profile's data files directly. This mitigation explicitly does
  **not** defend against XSS on the origin or against an attacker operating the user's browser.
- **D11** — At runtime the app makes **no network requests** after the initial asset load: no
  telemetry, no analytics, no remote fonts, icons, or CDN scripts, no time-sync call. All assets are
  same-origin and bundled. A Content-Security-Policy is shipped that permits only same-origin
  resources and forbids inline/eval script execution.
- **D12** — "Erase all local data" deletes the IndexedDB database including the wrapping key, after a
  confirmation step, and returns the app to the empty/import state. Decrypted secrets are held only
  in memory for the lifetime of the page.

### Code generation & UI

- **D13** — Codes are computed locally per RFC 6238 for TOTP with HMAC-SHA1 / SHA-256 / SHA-512 and
  6, 7, or 8 digits, with an arbitrary period. Entries whose token type is HOTP or Steam — or whose
  algorithm/digits are outside this range — are displayed in the list with an explicit "unsupported"
  badge and no code, never silently dropped and never shown a wrong code.
- **D14** — The app is a single-page React + TypeScript application built with Vite, styled with
  Tailwind CSS, deployed as static files (no server-side runtime, no backend, no database, no
  account system). It is installable/offline-capable as a PWA: after first load it opens and computes
  codes with no network available.
- **D15** — The list shows, per entry, the issuer/account, the current code (visually grouped for
  readability), and a countdown indicator of the remaining seconds in the current period. Codes
  refresh at least once per second and roll over within one second of the period boundary. Clicking
  an entry copies its current code to the clipboard with a transient confirmation; the clipboard is
  not auto-cleared. A search box filters the list client-side across issuer and account.
- **D16** — The UI is in Simplified Chinese and follows the OS light/dark preference. Code generation
  uses the device clock; a settings control lets the user apply a manual offset in seconds, which is
  persisted locally and applied to all code computation. The app never contacts a time server.

### Verification & non-goals

- **D17** — The lib layer is unit-tested: Base32 decoding, TOTP generation against the official
  RFC 6238 test vectors for all three hash algorithms, and 2FAS backup decrypt/parse against
  **synthetic** fixtures generated by the test suite itself. No real secret, real backup, or real
  account ever enters the repository.
- **D18 (non-goal)** — No backend, no user accounts, no server-side storage, no cross-device sync
  protocol, and no shared/multi-user vault.
- **D19 (non-goal)** — No export in any format (neither 2FAS-compatible nor proprietary); the
  original `.2fas` file remains the user's only backup artifact.
- **D20 (non-goal)** — No support for HOTP counters, Steam guard codes, 2FAS icon/brand assets,
  groups, or the 2FAS cloud/browser-extension pairing protocols.

## 3. Design

### 3.1 Architecture

Three layers, no framework state manager, no server (D14):

1. **`src/lib/` — pure, dependency-light, framework-free.** Base32 decoding, TOTP computation
   (D13), and 2FAS backup decryption + normalisation (D5, D7). Every function here is synchronous or
   returns a Promise over WebCrypto; none touch the DOM, IndexedDB, or React. This is the entire
   unit-test surface (D17).
2. **`src/store/` — persistence boundary.** Owns the IndexedDB database, the non-extractable
   wrapping key, encrypt-on-write / decrypt-on-read of entry records (D10), the atomic
   replace-all import write (D3), settings persistence (D16), and the erase operation (D12).
3. **`src/components/` + `src/App.tsx` — presentation.** Import dialog (D1, D3, D8), token list and
   cards with countdown/copy (D15), search (D2), settings panel with clock offset and erase (D12,
   D16). Entries are loaded once into React state on mount; a single shared 1 Hz ticker drives all
   card re-computation rather than a timer per card (D15).

Data flow, end to end: file → format sniff (`services` vs `servicesEncrypted`) → optional password
prompt and reference verification (D5) → normalise to `ServiceEntry[]` (D7, D9) → replace vault
(D3) → decrypt into memory on load → per-tick code computation (D13) → render (D15).

### 3.2 File-level plan

All files are new (§1). Paths are the contract the decomposition in §5 is cut along.

| Path | Role |
|------|------|
| `package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`, `postcss.config.js`, `eslint.config.js`, `vitest.config.ts` | Toolchain and build for the stack fixed in (D14); PWA plugin registration; test runner. |
| `index.html` | App shell; carries the CSP meta and theme-color (D11, D16). |
| `public/manifest.webmanifest`, PWA service worker (plugin-generated) | Offline/installable behaviour (D14). |
| `src/lib/base32.ts` | RFC 4648 Base32 decode (case-insensitive, padding-optional) → `Uint8Array`; throws a typed error on invalid input (feeds D9). |
| `src/lib/totp.ts` | `generateTotp()` per (D13) over WebCrypto `crypto.subtle.importKey`/`sign`; plus period-progress helper for (D15). |
| `src/lib/twofas/crypto.ts` | PBKDF2 key derivation and AES-GCM decryption primitives for (D5); parameters verified per (D6). |
| `src/lib/twofas/reference.ts` | The 2FAS reference constant and the password-verification check (D5, D6). |
| `src/lib/twofas/parse.ts` | Backup sniffing, schema-version gating, `servicesEncrypted` splitting, and normalisation to `ServiceEntry` (D5, D7, D8, D9). |
| `src/lib/twofas/types.ts` | Backup-shaped input types and the internal `ServiceEntry` (D7). |
| `src/store/db.ts` | IndexedDB open/upgrade; object stores for entries, the wrapping key, and settings (D10). |
| `src/store/vault.ts` | `VaultStore` implementation: `load`, `replaceAll`, `remove`, `reorder`, `erase`, encrypt/decrypt around the non-extractable key. Display order is persisted outside the ciphertext (D2, D3, D10, D12). |
| `src/store/settings.ts` | Clock-offset persistence (D16). |
| `src/hooks/useTicker.ts` | Single shared 1 Hz tick source for all cards (D15). |
| `src/hooks/useVault.ts` | Loads entries on mount; exposes import, per-entry delete, reorder and erase actions to the UI. Every action persists **before** touching in-memory state, so a failed write never leaves a phantom change on screen. |
| `src/hooks/useTypeToSearch.ts` | Page-wide keydown capture that focuses the search box on any printable key. Moves focus only — never `preventDefault` (see §3.3). |
| `src/lib/icons/resolve.ts` | Issuer-name normalisation and the five-step icon lookup (exact → alias → suffix strip → longest substring → hostname segment); deterministic letter-avatar colours; WCAG-luminance contrast helper. |
| `src/lib/icons/brands.generated.ts` | **Generated** — do not hand-edit. Sanitised colour brand marks baked in at build time by `scripts/gen-brand-icons.mjs`. |
| `src/components/ServiceIcon.tsx` | Brand mark or letter avatar; owns the tile background rules (white + tint, or solid brand colour for reverse-out logos) and the shared accent colour used by the row tint. |
| `scripts/gen-brand-icons.mjs` | Bakes icons from `@thesvg/icons` plus `assets/brand-icons/*.svg` through one sanitiser (see §3.3). Run via `npm run icons`. |
| `scripts/verify-file-build.mjs` | Post-build assertions on the single-file artifact: self-containment, CSP hash coverage, no service-worker remnants. |
| `vite.config.file.ts`, `assets/brand-icons/` | Single-file build config; hand-supplied SVGs for services absent upstream. |
| `src/components/ImportDialog.tsx` | File pick/drop, encrypted-backup password prompt, replace-all warning, error surface (D1, D3, D5, D8). |
| `src/components/TokenList.tsx`, `src/components/TokenCard.tsx` | List, per-entry code + countdown + copy, unsupported badge, per-entry delete (two-step confirm) and drag/keyboard reorder — reorder is disabled while a search filter is active (D2, D13, D15). |
| `src/components/SearchBar.tsx` | Client-side filter (D2, D15). |
| `src/components/SettingsPanel.tsx` | Clock offset control and erase-all with confirmation (D12, D16). |
| `src/components/EmptyState.tsx` | Pre-import state pointing at the import action (D1). |
| `src/App.tsx`, `src/main.tsx`, `src/index.css` | Composition, mount, Tailwind entry + dark-mode wiring (D16). |
| `README.md` | Build/deploy instructions and the security caveat from §1/(D10). |

### 3.3 Notes on non-obvious points

- **`servicesEncrypted` handling** — the field packs multiple base64 segments in one string; splitting
  and ordering them is exactly the part (D6) requires verifying against upstream rather than
  inferring. Keep the split in `parse.ts` and the crypto in `crypto.ts` so a corrected assumption
  touches one small function.
- **Non-extractable key round-trip** (D10) — generate with `crypto.subtle.generateKey(..., false,
  ['encrypt','decrypt'])` and `put` the resulting `CryptoKey` object directly into IndexedDB; the
  structured-clone algorithm stores it without ever exposing key material to JS.
- **Ticker alignment** (D15) — align the shared tick to the wall-clock second (schedule the next tick
  at `1000 - (now % 1000)`) so period rollovers land within the one-second bound rather than drifting.
- **Never reorder the DOM during a drag** (D2) — moving the dragged source node makes the browser
  abort the drag outright ("reordering does nothing"), and the reflow changes what sits under the
  cursor, firing another `dragOver` and oscillating. Show an absolutely-positioned drop indicator and
  commit the whole order on drop. jsdom does **not** reproduce either symptom, so the regression test
  asserts the invariant (row order unchanged across repeated `dragOver`) rather than the symptom.
- **`setDragImage` offsets** — the last two arguments are where the cursor sits *inside* the drag
  image. Passing `(0, 0)` pins the row's top-left to the cursor and the ghost jumps to its lower
  right; pass the cursor's real offset within the row.
- **Display order lives outside the ciphertext** (D2) — reordering then needs neither the wrapping key
  nor re-encryption. `load()` must sort by it: IndexedDB's `getAll()` returns **primary-key order**,
  so without the sort the list shows id order rather than the backup's own sequence.
- **Colour must travel as SVG presentation attributes** (D11) — per-entry colours cannot be Tailwind
  classes, and CSP forbids inline `style`. `fill` / `stroke` / `stroke-dasharray` attributes are not
  CSS and are unaffected. The row-wide tint additionally needs `isolation: isolate` on the row:
  `position: relative` with `z-index: auto` does **not** create a stacking context, so a `-z-10`
  child would paint *behind* the row's own opaque background and vanish.
- **Third-party SVG needs a sanitiser, not a copy-paste** — inline `style`/`<style>` are blocked by
  CSP, and inline SVG `id`s are document-scoped so `url(#a)` resolves to whichever icon rendered
  first (gradients bleed across icons). All three failures are silent. `scripts/gen-brand-icons.mjs`
  owns the whitelist, the style-to-attribute rewrite and the id namespacing; `resolve.test.ts` holds
  the resulting contract tests.
- **Type-to-search moves focus only** — focusing the input during `keydown` lets the browser deliver
  that keystroke to the newly focused element. Reconstructing the string by hand breaks IME
  composition and key repeat. Arrow keys must stay unhandled: they drive keyboard reordering.

## 4. Contracts Appendix

Frozen cross-boundary interfaces, verbatim TypeScript. Numeric crypto parameters are deliberately
absent here — they are (D6)'s verification obligation, not a frozen guess.

| Contract | Owner (task) | Form (verbatim) | Consumers | Canonical example / fixture |
|----------|--------------|-----------------|-----------|------------------------------|
| `ServiceEntry` | B | `type TokenType = 'TOTP' \| 'HOTP' \| 'STEAM' \| 'UNKNOWN';`<br>`type OtpAlgorithm = 'SHA1' \| 'SHA256' \| 'SHA512';`<br>`interface ServiceEntry { id: string; name: string; issuer: string \| null; account: string \| null; secret: string; algorithm: OtpAlgorithm; digits: number; period: number; tokenType: TokenType; unsupportedReason: string \| null; }` | C (persists), D (renders) | Fixture: one SHA1/6/30 TOTP entry + one `tokenType: 'HOTP'` entry with `unsupportedReason` set (D9, D13) |
| Backup import | B | `interface ParsedBackup { entries: ServiceEntry[]; schemaVersion: number; wasEncrypted: boolean; }`<br>`function isEncryptedBackup(raw: unknown): boolean;`<br>`function parseBackup(raw: unknown, password?: string): Promise<ParsedBackup>;` | D (import dialog) | Synthetic plaintext + synthetic encrypted backup generated in-test (D17) |
| Import errors | B | `type ImportErrorCode = 'INVALID_JSON' \| 'UNSUPPORTED_SCHEMA' \| 'NOT_A_BACKUP' \| 'PASSWORD_REQUIRED' \| 'WRONG_PASSWORD' \| 'DECRYPT_FAILED';`<br>`class ImportError extends Error { readonly code: ImportErrorCode; }` | D (error surface) | `WRONG_PASSWORD` from a good file + bad password (D5, D8) |
| TOTP | B | `function generateTotp(entry: ServiceEntry, atMs: number): Promise<string>;`<br>`function periodProgress(entry: ServiceEntry, atMs: number): { remainingSec: number; fraction: number };` | D (card render) | RFC 6238 vectors, secret `12345678901234567890`, t=59 → `94287082` (D17) |
| Base32 | B | `function base32Decode(input: string): Uint8Array;` | B (totp) | RFC 4648 vectors |
| Vault store | C | *(extended 2026-08-13 alongside the D2 amendment; the original three members are unchanged)*<br>`interface VaultStore { load(): Promise<ServiceEntry[]>; replaceAll(entries: ServiceEntry[]): Promise<void>; remove(id: string): Promise<void>; reorder(orderedIds: string[]): Promise<void>; erase(): Promise<void>; }`<br>`interface SettingsStore { getClockOffsetSec(): Promise<number>; setClockOffsetSec(sec: number): Promise<void>; }` | D (hooks/UI) | `replaceAll` twice → second call's entries are the only ones `load` returns (D3) |

## 5. Suggested Decomposition

| ID | Scope (files) | Depends | Effort | One-line goal |
|----|---------------|---------|--------|---------------|
| A | `package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`, `postcss.config.js`, `eslint.config.js`, `vitest.config.ts`, `index.html`, `public/manifest.webmanifest`, `src/main.tsx`, `src/App.tsx` (placeholder), `src/index.css`, `.gitignore` | — | low | Stand up the Vite/React/TS/Tailwind/PWA skeleton with CSP and a green `build` + `test` + `lint` baseline (D11, D14). |
| B | `src/lib/base32.ts`, `src/lib/totp.ts`, `src/lib/twofas/*.ts` + their `*.test.ts` | A | high | Implement and unit-test Base32, TOTP, and 2FAS backup decrypt/parse/normalise, verifying upstream parameters (D5–D9, D13, D17). |
| C | `src/store/db.ts`, `src/store/vault.ts`, `src/store/settings.ts` + tests | A, B | medium | Persist entries encrypted under a non-extractable key with replace-all, erase, and settings (D3, D10, D12, D16). |
| D | `src/App.tsx`, `src/hooks/*.ts`, `src/components/*.tsx` | B, C | high | Build the import flow, live token list with countdown/copy/search, unsupported badges, and settings panel (D1, D2, D8, D12, D13, D15, D16). |
| E | `README.md`, PWA/offline wiring verification, deploy config | D | low | Verify offline-first behaviour and zero runtime network requests, and document build/deploy plus the security caveat (D11, D14). |

Dependency graph is acyclic: A → {B, C}, B → C, {B, C} → D → E.

## 6. Verification

The toolchain does not exist yet (§1); these commands are the ones task A is responsible for making
real, and every later task is verified against them.

**Task-scoped acceptance**

- A: `npm run build` produces a static bundle; `npm run lint` and `npm test` exit 0 on the skeleton;
  `index.html` contains the CSP (D11).
- B: `npm test -- src/lib` — RFC 6238 vectors pass for SHA1/SHA256/SHA512 at 6 and 8 digits; a
  synthetic encrypted backup round-trips; a wrong password yields `WRONG_PASSWORD` without writing
  anything (D5, D8, D13, D17).
- C: `npm test -- src/store` — under a fake-IndexedDB environment, `replaceAll` is destructive-replace
  (D3), stored records contain no plaintext Base32 secret (D10), and `erase` leaves `load` empty (D12).
- D: `npm run build` + manual pass — import a synthetic backup, see codes tick and roll over on the
  period boundary, click-to-copy works, an HOTP entry shows the unsupported badge, search filters,
  clock offset changes the computed code (D13, D15, D16).
- E: load the built app, go offline, reload — codes still render; the network panel shows no
  third-party or runtime requests (D11, D14).

**Repo-wide validation suite** (run before any task is considered done):

```bash
npm run lint && npx tsc --noEmit && npm test && npm run build
```
