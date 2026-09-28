# 0005 — TypeScript version (D11)

**Status:** Accepted 2026-09-28

## Rule
Production reliability over newest version. Use the newest TypeScript that the **whole** toolchain supports; pin exact versions (no `^`/`~` on majors) in `package.json` and commit the lockfile.

## Compatibility check (2026-09-28)

| Tool | Version | TypeScript support |
|---|---|---|
| typescript (latest) | 7.0.2 | — |
| typescript-eslint / @typescript-eslint/parser | 8.71.0 | peer `typescript >=4.8.4 <6.1.0` → **TS 7 unsupported** |
| eslint-config-next | 16.3.6 | depends on typescript-eslint ^8 |
| Next.js | 16.3.6 | no TS peer constraint |
| Vitest | 5.0.2 | no TS peer constraint |

typescript-eslint does not support TypeScript 7, so the lint pipeline would be unsupported. **Decision: pin TypeScript 6.0.3** (latest 6.0.x within typescript-eslint's range).

Re-evaluate when typescript-eslint declares TS 7 support.
