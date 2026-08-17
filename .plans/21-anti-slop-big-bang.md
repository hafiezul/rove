# Anti-Slop Big-Bang Migration

## Goal

Merge the anti-slop Oxlint installation only after `vp check` reports no anti-slop diagnostics across every linted file. Keep every installed rule enabled at `error`; do not add ignores, baselines, rule exceptions, unsafe cast helpers, or mechanical `SAFETY:` comments.

## Baseline

The initial whole-repository lint found 8,780 anti-slop diagnostics in 2,540 files:

| Rule | Diagnostics |
| --- | ---: |
| `require-safety-comment-for-type-assertion` | 2,613 |
| `no-conditional-empty-object-spread` | 1,732 |
| `no-runtime-typeof` | 1,524 |
| `no-unsafe-dictionary-type` | 887 |
| `no-unknown-parameters` | 570 |
| `no-shape-in-symbol-names` | 566 |
| `no-known-value-widening` | 484 |
| `no-chained-type-assertions` | 323 |
| remaining anti-slop rules | 81 |

## Current checkpoint

After the type-evidence migration, the current full-tree lint has **7,327** anti-slop diagnostics. `anti-slop(no-known-value-widening)` is at **zero** (down from 484 at the initial baseline), and `corepack pnpm run typecheck` passes. The remaining highest-volume work is assertion safety (2,582), conditional empty-object spreads (1,732), runtime `typeof` (1,522), unsafe dictionaries (558), unknown parameters (566), chained assertions (318), and unknown returns (49).

## Migration order

1. **Mechanical-but-semantic structural repairs**
   - Rename `*Shape` service and contract symbols to role-based `*Contract` names, with specific names for the few non-contract symbols.
   - Replace conditional empty-object spreads with explicit object construction that preserves omission semantics and property order.
   - Replace direct `Reflect.get` calls with validated typed access.
2. **Boundary contracts**
   - Introduce or reuse named domain/JSON contracts at external boundaries.
   - Replace broad dictionary types and explicitly `unknown` function contracts with decoded owner types.
   - Replace raw runtime `typeof` checks with named parser/refinement functions at the correct boundary; do not hide checks behind generic cast helpers.
3. **Type-evidence preservation**
   - Replace widening annotations with inference, `satisfies`, or named domain contracts.
   - Remove chained assertions by modeling test doubles and production adapters with typed interfaces.
   - Eliminate assertions where possible; where an assertion remains necessary, add a local `SAFETY:` comment that states the proven invariant.
4. **Low-volume rule cleanup**
   - Remove broad `object` parameters, unknown aliases, and dynamic reflection.
   - Resolve any newly exposed non-anti-slop lint failures rather than suppressing them.

## Guardrails

- Make each transformation batch independently typecheck before expanding it.
- Preserve public behavior; add or extend focused tests before changing an untested behavior boundary.
- Prefer existing Effect Schema contracts and project conventions over new dependencies or generic wrappers.
- Keep migration scripts outside the repository or delete them before completion.
- Do not change the anti-slop rule configuration except to keep every rule enabled at `error`.

## Verification gates

After each batch:

```bash
vp lint --format json
corepack pnpm run typecheck
```

Before completion:

```bash
vp check
vpr typecheck
vp run test
```

`vp check` must have zero lint errors, including existing project rules; `vpr typecheck` and the test suite must pass.
