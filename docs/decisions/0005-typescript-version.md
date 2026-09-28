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

## Related toolchain choices (same rule: supported over newest)

| Choice | Reason |
|---|---|
| **ESLint 10.11.0**, not 9 | ESLint 9 is end-of-life ("no longer supported" on npm). |
| No `eslint-config-next`; config composed from `typescript-eslint`, `@next/eslint-plugin-next`, `eslint-plugin-react-hooks`, `@eslint-react/eslint-plugin` | `eslint-config-next` 16.3.6 bundles `eslint-plugin-react`, `-import` and `-jsx-a11y`, whose peer ranges stop at ESLint 9. The composed set all declare ESLint 10 support. Accessibility linting (`jsx-a11y`) is therefore not active; accessibility is covered by Playwright checks from M6 (axe). |
| No `vite-tsconfig-paths` | Its dependency `tsconfck` is deprecated and caps TypeScript at ^5. A plain Vitest alias does the same job. |
| `@types/node` 22.x | Matches the Node 22 LTS runtime. |

All versions are exact in `package.json`; `pnpm-lock.yaml` is committed.
