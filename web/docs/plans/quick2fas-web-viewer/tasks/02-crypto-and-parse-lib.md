# T02: Crypto & Parse Library (Base32, TOTP, 2FAS Backup)

**Verification mode:** `auto`
**Heavy:** false
**Effort:** high

## Dependencies

- **T01** — provides the toolchain, TypeScript config, and the Vitest environment this task's tests
  run in.

## Contracts

Copy each form **verbatim**; do not paraphrase or re-shape.

- **Owns**: `type TokenType = 'TOTP' | 'HOTP' | 'STEAM' | 'UNKNOWN';`
  `type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';`
  `interface ServiceEntry { id: string; name: string; issuer: string | null; account: string | null; secret: string; algorithm: OtpAlgorithm; digits: number; period: number; tokenType: TokenType; unsupportedReason: string | null; }`
- **Owns**: `interface ParsedBackup { entries: ServiceEntry[]; schemaVersion: number; wasEncrypted: boolean; }`
  `function isEncryptedBackup(raw: unknown): boolean;`
  `function parseBackup(raw: unknown, password?: string): Promise<ParsedBackup>;`
- **Owns**: `type ImportErrorCode = 'INVALID_JSON' | 'UNSUPPORTED_SCHEMA' | 'NOT_A_BACKUP' | 'PASSWORD_REQUIRED' | 'WRONG_PASSWORD' | 'DECRYPT_FAILED';`
  `class ImportError extends Error { readonly code: ImportErrorCode; }`
- **Owns**: `function generateTotp(entry: ServiceEntry, atMs: number): Promise<string>;`
  `function periodProgress(entry: ServiceEntry, atMs: number): { remainingSec: number; fraction: number };`
- **Owns**: `function base32Decode(input: string): Uint8Array;`
- **Consumes** (from T01): the `test` / `typecheck` / `lint` scripts.

## Goal

Implement the entire framework-free library layer of design §3.1: Base32 decoding, RFC 6238 code
generation over WebCrypto, and 2FAS backup sniffing / decryption / normalisation. Nothing here
touches the DOM, IndexedDB, or React — this is the whole unit-test surface of the project (D17) and
the foundation both T03 and T04 build on.

## Scope

**Files to create:**
- `src/lib/base32.ts` — RFC 4648 Base32 decode
- `src/lib/totp.ts` — `generateTotp`, `periodProgress`
- `src/lib/twofas/types.ts` — backup-shaped input types + `ServiceEntry`
- `src/lib/twofas/crypto.ts` — PBKDF2 derivation + AES-GCM decrypt primitives
- `src/lib/twofas/reference.ts` — the 2FAS reference constant + password verification
- `src/lib/twofas/parse.ts` — sniffing, schema gating, `servicesEncrypted` splitting, normalisation
- `src/lib/twofas/errors.ts` — `ImportError` / `ImportErrorCode`
- `src/lib/base32.test.ts`, `src/lib/totp.test.ts`, `src/lib/twofas/parse.test.ts`,
  `src/lib/twofas/crypto.test.ts`

**Files to modify:** `package.json` only if a genuinely required runtime dependency is missing
(prefer zero — WebCrypto covers everything here).

**Out of scope:** IndexedDB / persistence of any kind (T03), React components and hooks (T04), QR
decoding, manual entry, `otpauth://` parsing, export in any format (D1, D19).

## Requirements

1. `base32Decode` implements RFC 4648 Base32: case-insensitive, padding optional, whitespace
   tolerated. Invalid characters throw a typed error (feeds D9's per-entry tolerance).
2. `generateTotp` implements RFC 6238 over `crypto.subtle` HMAC with SHA-1 / SHA-256 / SHA-512, 6-8
   digits, arbitrary period, zero-padded output (D13).
3. `periodProgress` returns the seconds remaining in the current period and a 0-1 fraction for the
   countdown indicator (D15).
4. `parseBackup` supports plaintext backups (`services[]` populated) and officially encrypted
   backups (`servicesEncrypted` populated), for `schemaVersion` 2 through 4 (D5).
5. For an encrypted backup: derive the key with PBKDF2-SHA256 and decrypt with AES-256-GCM, matching
   the upstream 2FAS scheme. Verify the password by decrypting the backup's `reference` field and
   comparing it to the known 2FAS reference constant **before** returning any entry; a mismatch
   throws `ImportError` with code `WRONG_PASSWORD` and produces no entries (D5).
6. **(D6)** The exact upstream constants — PBKDF2 iteration count, hash, salt/IV byte lengths, the
   `servicesEncrypted` delimiter and part order, and the `reference` plaintext constant — must be
   taken from the 2FAS open-source implementation (`twofas/android`, `twofas/ios`), not guessed.
   Put every one of them in a single exported, commented constants block in `crypto.ts` /
   `reference.ts` with a source note, so a correction touches one place. Record in a comment that
   real-backup confirmation is manual task M02.
7. Each entry is normalised per (D7): stable id, issuer, account, display name, Base32 secret,
   algorithm, digits, period, token type. Missing fields default to SHA1 / 6 digits / 30 seconds.
8. **(D8)** A file that is not valid JSON → `INVALID_JSON`; an unrecognised/absent `schemaVersion` →
   `UNSUPPORTED_SCHEMA`; neither `services` nor `servicesEncrypted` → `NOT_A_BACKUP`; an encrypted
   backup with no password argument → `PASSWORD_REQUIRED`; AES-GCM failure after a passing reference
   check → `DECRYPT_FAILED`. Errors are thrown, never returned as a half-filled `ParsedBackup`.
9. **(D9)** A single malformed entry never aborts the import: it is returned in `entries` with
   `unsupportedReason` set to a human-readable reason.
10. **(D13)** Entries whose `tokenType` is `HOTP` or `STEAM`, or whose algorithm/digits fall outside
    the supported set, get `unsupportedReason` set and must never yield a computed code.
11. **(D17)** Tests use only synthetic fixtures the suite builds itself. No real backup file, real
    secret, or real account may enter the repository. Tests must be offline and deterministic — pass
    an explicit `atMs` rather than reading the clock.

## Tests to implement

- `src/lib/base32.test.ts`:
  - "decodes RFC 4648 test vectors" — asserts the standard vector set decodes byte-exactly
  - "accepts lowercase, missing padding and whitespace" — asserts equivalence to the canonical form
  - "throws on an invalid character" — asserts a typed error, not a silent partial decode
- `src/lib/totp.test.ts`:
  - "matches RFC 6238 vectors for SHA1" — 20-byte ASCII seed `12345678901234567890`, 8 digits,
    t=59s → `94287082` (the contract's canonical fixture)
  - "matches RFC 6238 vectors for SHA256 and SHA512" — note the RFC uses **different seed lengths**
    per algorithm (32-byte and 64-byte ASCII seeds, not the 20-byte one); use the correct seed per
    algorithm or the vectors will not reproduce
  - "pads short codes to the requested digit count" — asserts leading zeros are preserved
  - "periodProgress reports the period boundary" — asserts `remainingSec` at the start, middle, and
    last second of a 30s window
- `src/lib/twofas/crypto.test.ts`:
  - "round-trips a payload encrypted with the documented parameters" — the test encrypts with the
    same constants and asserts decryption returns the original plaintext
  - "rejects a wrong password" — asserts the reference check fails rather than returning garbage
- `src/lib/twofas/parse.test.ts`:
  - "parses a plaintext backup into normalised entries" — asserts field mapping and the SHA1/6/30
    defaults (D7)
  - "parses a synthetic encrypted backup" — fixture built in-test; asserts `wasEncrypted: true` and
    the entry list matches the plaintext case
  - "throws WRONG_PASSWORD for a good file and a bad password" — asserts the `ImportError.code`
    (the contract's canonical error fixture) and that no entries are produced
  - "throws PASSWORD_REQUIRED when an encrypted backup gets no password"
  - "throws INVALID_JSON / UNSUPPORTED_SCHEMA / NOT_A_BACKUP for the corresponding malformed inputs"
  - "marks an HOTP entry unsupported instead of dropping it" — asserts the entry is present with
    `tokenType: 'HOTP'` and a non-null `unsupportedReason` (D13)
  - "keeps a malformed entry with a reason instead of aborting the import" (D9)

## Test Impact

None found — verified by `git ls-files` returning no files; only T01's `src/App.test.tsx` exists
before this task, and it asserts nothing about the lib layer.

## Design Reference

See [../design.md](../design.md) §3.1-3.3 (lib layer, `servicesEncrypted` note), §4 (contracts), and
decisions D5-D9, D13, D17.

## Acceptance Criteria

1. `npx vitest run src/lib` — single command, all lib tests pass (the primary machine-verifiable gate)
2. `npm run typecheck` — zero errors
3. `npx eslint src/lib` — zero errors
4. No file under `src/lib/` imports React, a DOM API beyond `crypto.subtle`/`TextEncoder`, or
   anything from `src/store/` or `src/components/`
5. No real `.2fas` file or real secret is committed; every fixture is generated inside the test files
