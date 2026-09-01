# T01: Project Skeleton (Vite + React + TS + Tailwind + PWA)

**Verification mode:** `auto`
**Heavy:** true
**Effort:** low

## Dependencies

None. This is a foundational task. The repository is empty — there is no `package.json`, no source
file, and no tooling of any kind (verified: `git ls-files` returns nothing).

## Contracts

- **Owns**: the npm scripts every later task is verified with — `dev`, `build`, `preview`,
  `lint`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`, non-watch). Script names are frozen;
  downstream acceptance commands call them by these exact names.
- **Owns**: the test environment later tasks rely on — Vitest with a DOM environment (jsdom or
  happy-dom), `@testing-library/react` + `@testing-library/jest-dom`, `fake-indexeddb`, and a setup
  file registered in `vitest.config.ts`. T03 needs IndexedDB and WebCrypto in tests; T04 needs DOM
  rendering and fake timers.

## Goal

Stand up the complete toolchain the design fixes in (D14) — a React + TypeScript single-page app
built by Vite, styled with Tailwind, shipped as static files with PWA offline support — plus the
CSP and zero-third-party-asset posture of (D11), and a README documenting build/deploy and the
security caveat from design §1. Every later task inherits this baseline; it must be green before
anything else starts.

## Scope

**Files to create:**
- `package.json` — dependencies and the frozen scripts (see Contracts)
- `package-lock.json` — committed deliberately (this task owns dependency resolution)
- `vite.config.ts` — React plugin + PWA plugin registration
- `tsconfig.json`, `tsconfig.node.json` — strict TypeScript
- `tailwind.config.js`, `postcss.config.js` — Tailwind wiring, class-based or media dark mode
- `eslint.config.js` — lint for TS + React
- `vitest.config.ts` — DOM environment, setup file, coverage off by default
- `src/test/setup.ts` — testing-library matchers + `fake-indexeddb/auto` registration
- `index.html` — app shell, CSP meta, theme-color, `lang="zh-CN"`
- `public/manifest.webmanifest` — PWA manifest (name, icons, display, theme)
- `src/main.tsx`, `src/App.tsx` — mount + placeholder shell (T04 replaces the shell's content)
- `src/index.css` — Tailwind entry, dark-mode base styles
- `src/App.test.tsx` — smoke test so `npm test` has a subject
- `.gitignore` — `node_modules`, `dist`, `.DS_Store`, local env files
- `README.md` — build/dev/deploy instructions + the security caveat

**Files to modify:** none.

**Out of scope:** Base32/TOTP/2FAS logic (T02), IndexedDB storage (T03), any real UI — import
dialog, token list, search, settings (T04). `src/App.tsx` stays a placeholder shell. Do not add
icon/brand asset pipelines, analytics, error reporting, or any runtime dependency that fetches from
a third-party origin.

## Requirements

1. Stack is exactly React + TypeScript + Vite + Tailwind CSS, output is static files, with **no**
   backend, server runtime, database, or account system (D14, D18).
2. PWA support is configured so the built app opens and works offline after first load (D14). Use a
   Vite PWA plugin with precaching of the built assets; the manifest is a real file under `public/`.
3. `index.html` ships a Content-Security-Policy that permits only same-origin resources and forbids
   inline/`eval` script execution (D11). Tailwind/Vite must be configured so the production build
   does not require an inline-script or inline-style exemption that defeats this; if a style-src
   allowance is unavoidable, document the exact reason in `README.md`.
4. No third-party CDN, remote font, or remote icon reference anywhere in `index.html`,
   `src/index.css`, or the manifest (D11). All assets are bundled and same-origin.
5. UI language is Simplified Chinese and dark mode follows the OS preference (D16) — set the
   document language and the Tailwind dark-mode strategy here; the placeholder shell renders one
   Chinese heading proving both are wired.
6. Scripts are named exactly as frozen in Contracts. `npm test` runs Vitest **once** (no watch mode)
   so it terminates under automation.
7. TypeScript runs in strict mode; `npm run typecheck` is `tsc --noEmit` and exits 0.
8. `README.md` documents: install/dev/build/preview commands, how to deploy the `dist/` output as a
   static site, and the security caveat from design §1 — that browser-held seeds collapse the
   phone/computer separation, and that (D10)'s at-rest encryption does not defend against XSS or an
   attacker operating the user's browser.

## Tests to implement

- `src/App.test.tsx`:
  - "renders the app shell" — renders `<App />` with `@testing-library/react` and asserts the
    Chinese placeholder heading is in the document (proves the DOM test environment, JSX pipeline,
    and setup file are all wired).

## Test Impact

None found — the repository contains no tests (verified: `git ls-files` is empty).

## Design Reference

See [../design.md](../design.md) §3.2 (file-level plan), §6 (verification), and decisions D11, D14,
D16, D18.

## Acceptance Criteria

1. `npm run build` — exits 0 and produces `dist/` containing the app bundle, the web manifest, and a
   generated service worker (the primary machine-verifiable gate; repo-wide, hence `Heavy: true`)
2. `npm run lint` — zero errors
3. `npm run typecheck` — zero errors
4. `npx vitest run src/App.test.tsx` — the smoke test passes
5. `index.html` contains a `Content-Security-Policy` meta tag restricted to same-origin sources with
   no `unsafe-eval`
6. No file under `index.html`, `src/`, or `public/` references an external origin (no `http://` or
   `https://` asset URL pointing off-origin)
