# T04: Viewer UI (Import Flow, Live Token List, Search, Settings)

**Verification mode:** `auto`
**Heavy:** false
**Effort:** high

## Dependencies

- **T02** — owns backup parsing, the error codes, and code generation.
- **T03** — owns the vault and settings persistence.

## Contracts

Copy each form **verbatim**; do not paraphrase or re-shape.

- **Consumes** (from T02): `interface ParsedBackup { entries: ServiceEntry[]; schemaVersion: number; wasEncrypted: boolean; }`
  `function isEncryptedBackup(raw: unknown): boolean;`
  `function parseBackup(raw: unknown, password?: string): Promise<ParsedBackup>;`
- **Consumes** (from T02): `type ImportErrorCode = 'INVALID_JSON' | 'UNSUPPORTED_SCHEMA' | 'NOT_A_BACKUP' | 'PASSWORD_REQUIRED' | 'WRONG_PASSWORD' | 'DECRYPT_FAILED';`
  `class ImportError extends Error { readonly code: ImportErrorCode; }`
- **Consumes** (from T02): `function generateTotp(entry: ServiceEntry, atMs: number): Promise<string>;`
  `function periodProgress(entry: ServiceEntry, atMs: number): { remainingSec: number; fraction: number };`
- **Consumes** (from T02): `interface ServiceEntry { id: string; name: string; issuer: string | null; account: string | null; secret: string; algorithm: OtpAlgorithm; digits: number; period: number; tokenType: TokenType; unsupportedReason: string | null; }`
- **Consumes** (from T03): `interface VaultStore { load(): Promise<ServiceEntry[]>; replaceAll(entries: ServiceEntry[]): Promise<void>; erase(): Promise<void>; }`
  `interface SettingsStore { getClockOffsetSec(): Promise<number>; setClockOffsetSec(sec: number): Promise<void>; }`

## Goal

Build the presentation layer of design §3.1: the import dialog, the live token list with countdown
and click-to-copy, the client-side search, the unsupported-entry badge, and the settings panel with
clock offset and erase-all. This task replaces T01's placeholder `src/App.tsx` with the real app.

## Scope

**Files to create:**
- `src/hooks/useTicker.ts` — one shared 1 Hz tick source for all cards
- `src/hooks/useVault.ts` — loads entries on mount, exposes import/erase actions
- `src/components/ImportDialog.tsx` — file pick/drop, password prompt, replace warning, errors
- `src/components/TokenList.tsx`, `src/components/TokenCard.tsx` — list and per-entry rendering
- `src/components/SearchBar.tsx` — client-side filter
- `src/components/SettingsPanel.tsx` — clock offset + erase-all with confirmation
- `src/components/EmptyState.tsx` — pre-import state
- `src/components/TokenCard.test.tsx`, `src/components/ImportDialog.test.tsx`,
  `src/components/TokenList.test.tsx`, `src/components/SettingsPanel.test.tsx`

**Files to modify:** `src/App.tsx` (compose the real UI), `src/App.test.tsx` (replace the T01 smoke
assertion with a real shell assertion), `src/index.css` only if a base style is genuinely needed.

**Out of scope:** anything under `src/lib/` or `src/store/` — if a needed behavior is missing there,
the contract is wrong; stop and reconcile rather than reimplementing it here. Also out of scope: QR
scanning, manual entry, editing/reordering/grouping entries, per-entry delete, export, and any
network call (D1, D2, D11, D19, D20).

## Requirements

1. **(D1)** The only import path is a 2FAS backup file chosen from disk or dropped on the page. No
   camera, no QR, no manual secret entry, no URI paste anywhere in the UI.
2. **(D5)** When `isEncryptedBackup` is true, prompt for the backup password before importing.
3. **(D3)** The import dialog states that importing **replaces** the entire local vault before the
   replacement is committed.
4. **(D8)** Every `ImportErrorCode` maps to a specific, human-readable Chinese message naming what
   failed. A failed import leaves the existing vault untouched and never blanks the UI.
5. **(D2)** The UI offers no create/edit/rename/reorder/group/per-entry-delete affordance. Search and
   the global erase action are the only interactions besides copying.
6. **(D13)** An entry with a non-null `unsupportedReason` renders with an explicit "unsupported"
   badge and **no code** — never a placeholder code and never a wrong one.
7. **(D15)** Each card shows issuer/account, the current code in a visually grouped form, and a
   countdown indicator of the seconds remaining. Codes refresh at least once per second and roll over
   within one second of the period boundary — drive this from the single shared ticker in
   `useTicker.ts`, aligned to the wall-clock second (schedule the next tick at `1000 - (now % 1000)`),
   not one timer per card.
8. **(D15)** Clicking an entry copies its current code to the clipboard and shows a transient
   confirmation. The clipboard is never auto-cleared.
9. **(D15)** The search box filters the list client-side across issuer and account.
10. **(D16)** UI text is Simplified Chinese; dark mode follows the OS preference. The settings panel
    exposes the clock offset in seconds, persists it via `SettingsStore`, and applies it to the
    `atMs` passed to `generateTotp` for every card. The app never contacts a time server.
11. **(D12)** Erase-all requires a confirmation step, then calls `VaultStore.erase()` and returns the
    app to the empty/import state.
12. **(D11)** No component fetches anything at runtime — no remote fonts, icons, images, or telemetry.
13. Tests must be deterministic and offline: fake timers for the ticker, a fixed `atMs`, an injected
    or mocked `VaultStore`/`SettingsStore`, and a stubbed `navigator.clipboard`. Components must
    therefore accept their stores/time source through props or a context rather than importing a
    module-level singleton that tests cannot replace.

## Tests to implement

- `src/components/TokenCard.test.tsx`:
  - "renders the code for a supported entry" — seam test against the contract's canonical TOTP
    fixture at a fixed `atMs`; asserts the code produced by the real `generateTotp`
  - "renders an unsupported badge and no code for an HOTP entry" — asserts the badge text and the
    absence of any digit group (D13)
  - "advances the code at the period boundary" — with fake timers, asserts the rendered code changes
    within one second of the boundary (D15)
  - "copies the code on click" — asserts the stubbed `navigator.clipboard.writeText` receives the
    displayed code and a confirmation appears (D15)
- `src/components/ImportDialog.test.tsx`:
  - "prompts for a password for an encrypted backup" — asserts the prompt appears only when
    `isEncryptedBackup` is true (D5)
  - "shows a specific message for WRONG_PASSWORD and keeps the existing vault" — asserts the message
    and that `replaceAll` was not called (D8)
  - "warns that import replaces the whole vault before committing" (D3)
  - "shows a specific message for INVALID_JSON / NOT_A_BACKUP" (D8)
- `src/components/TokenList.test.tsx`:
  - "filters entries by issuer and by account" — asserts the search box narrows the rendered list (D15)
  - "renders the empty state when the vault has no entries"
- `src/components/SettingsPanel.test.tsx`:
  - "persists the clock offset and shifts the computed code" — asserts `setClockOffsetSec` is called
    and that a card's code changes to the value expected for the offset time (D16)
  - "erases all data only after confirmation" — asserts `erase()` is not called before confirming and
    is called after, leaving the empty state (D12)

## Test Impact

- `src/App.test.tsx` (created by T01) — "renders the app shell" asserts the OLD placeholder heading;
  update it to assert the real shell (empty state before import, list after) as part of this task.
- No other existing test asserts UI behavior — verified by grepping the component and hook symbols
  above across the repo.

## Design Reference

See [../design.md](../design.md) §3.1-3.3 (presentation layer, ticker alignment note), §4
(contracts), and decisions D1-D3, D8, D11-D13, D15, D16, D19, D20.

## Acceptance Criteria

1. `npx vitest run src/components src/hooks src/App.test.tsx` — single command, all UI tests pass
   (the primary machine-verifiable gate)
2. `npm run typecheck` — zero errors
3. `npx eslint src/components src/hooks src/App.tsx` — zero errors
4. No file under `src/components/` or `src/hooks/` calls `fetch`, `XMLHttpRequest`, or references an
   external origin (D11)
5. No file under `src/components/` or `src/hooks/` imports `indexedDB` directly — all persistence
   goes through `src/store/` (design §3.1)
