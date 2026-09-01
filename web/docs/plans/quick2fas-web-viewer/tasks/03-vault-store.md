# T03: Vault Store (Encrypted IndexedDB Persistence)

**Verification mode:** `auto`
**Heavy:** false
**Effort:** medium

## Dependencies

- **T01** — toolchain, Vitest environment, and `fake-indexeddb` registration in `src/test/setup.ts`.
- **T02** — owns the `ServiceEntry` shape this store persists.

## Contracts

Copy each form **verbatim**; do not paraphrase or re-shape.

- **Owns**: `interface VaultStore { load(): Promise<ServiceEntry[]>; replaceAll(entries: ServiceEntry[]): Promise<void>; erase(): Promise<void>; }`
  `interface SettingsStore { getClockOffsetSec(): Promise<number>; setClockOffsetSec(sec: number): Promise<void>; }`
- **Consumes** (from T02): `interface ServiceEntry { id: string; name: string; issuer: string | null; account: string | null; secret: string; algorithm: OtpAlgorithm; digits: number; period: number; tokenType: TokenType; unsupportedReason: string | null; }` — import the type from `src/lib/twofas/types.ts`; do not redeclare or widen it.

## Goal

Implement the persistence boundary of design §3.1: an IndexedDB-backed vault that stores entries
encrypted under a non-extractable AES-GCM key (D10), replaces the whole vault atomically on import
(D3), erases everything on demand (D12), and persists the clock offset setting (D16). This is the
only layer in the app allowed to touch IndexedDB.

## Scope

**Files to create:**
- `src/store/db.ts` — database open/upgrade; object stores for entries, the wrapping key, settings
- `src/store/vault.ts` — `VaultStore` implementation with encrypt-on-write / decrypt-on-read
- `src/store/settings.ts` — `SettingsStore` implementation
- `src/store/vault.test.ts`, `src/store/settings.test.ts`

**Files to modify:** `package.json` only if an IndexedDB helper library is genuinely needed (a thin
hand-rolled wrapper is acceptable and preferred over a dependency).

**Out of scope:** parsing or decrypting backup files (T02), React hooks and components (T04), any
unlock/lock screen or password prompt for the vault itself — there is none (D10), and any export
functionality (D19).

## Requirements

1. **(D10)** There is no unlock password and no lock screen: `load()` returns entries immediately on
   page load with no user interaction.
2. **(D10)** Entry records are stored encrypted. The wrapping key is created with
   `crypto.subtle.generateKey(..., false, ['encrypt', 'decrypt'])` — `extractable: false` — and
   persisted by putting the resulting `CryptoKey` object directly into IndexedDB (structured clone
   stores it without exposing key material). The key is generated once on first write and reused.
3. A stored record must contain **no plaintext Base32 secret**. Whether other fields are encrypted is
   an implementation choice, but `secret` must never be readable from a raw IndexedDB record.
4. **(D3)** `replaceAll(entries)` discards every prior entry and stores exactly the given set — no
   merge, no de-duplication, no partial write. A failure mid-write must not leave a mixed vault
   (use a single transaction, or clear-then-write within one transaction).
5. **(D12)** `erase()` deletes the whole database including the wrapping key, so a subsequent
   `load()` returns an empty array and a subsequent write generates a fresh key.
6. **(D16)** `SettingsStore` persists a clock offset in seconds, defaulting to `0` when never set.
   Negative and positive values are both valid.
7. `load()` on a never-written database returns `[]` — it does not throw and does not create noise.
8. **Test-environment note:** keep key acquisition behind one small internal seam (e.g. a
   `getOrCreateKey()` function or an injectable key provider) so the suite can substitute a key if
   the fake IndexedDB implementation cannot structured-clone a `CryptoKey`. Do **not** change the
   public `VaultStore` shape to accommodate tests, and do not weaken the `extractable: false`
   guarantee in the production path.
9. Tests are offline and deterministic: `fake-indexeddb` for storage, the Node WebCrypto
   implementation for keys, no network, no real clock dependence.

## Tests to implement

- `src/store/vault.test.ts`:
  - "load returns an empty array for a fresh database" — asserts `[]`, no throw
  - "replaceAll then load round-trips entries" — seam test: uses the contract's canonical fixture
    (one SHA1/6/30 TOTP entry + one `tokenType: 'HOTP'` entry with `unsupportedReason` set) and
    asserts every field of `ServiceEntry` survives the round trip byte-for-byte
  - "replaceAll is destructive" — asserts that after two `replaceAll` calls, `load` returns only the
    second call's entries (D3)
  - "stored records contain no plaintext secret" — reads the raw IndexedDB record and asserts the
    fixture's Base32 secret string does not appear anywhere in it (D10)
  - "erase clears entries and the key" — asserts `load` returns `[]` after `erase`, and that a
    following `replaceAll` + `load` still works (fresh key generated)
- `src/store/settings.test.ts`:
  - "clock offset defaults to 0" — asserts the unset default (D16)
  - "clock offset persists across store instances" — asserts a written offset is read back by a
    newly constructed store, including a negative value

## Test Impact

None found — verified by grepping for `VaultStore` / `SettingsStore` across the repo: these symbols
do not exist before this task, and no existing test asserts storage behavior.

## Design Reference

See [../design.md](../design.md) §3.1-3.3 (store layer, non-extractable key round-trip note), §4
(contracts), and decisions D3, D10, D12, D16.

## Acceptance Criteria

1. `npx vitest run src/store` — single command, all store tests pass (the primary machine-verifiable gate)
2. `npm run typecheck` — zero errors
3. `npx eslint src/store` — zero errors
4. No file under `src/store/` imports React or anything from `src/components/`
5. `src/store/vault.ts` calls `crypto.subtle.generateKey` with `extractable: false` in the production
   path
