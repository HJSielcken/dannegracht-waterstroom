# Bijdragen

## Branches

- `main` is altijd deploybaar; er wordt niet direct op gepusht.
- Werk op een feature-branch (`feat/...`, `fix/...`, `docs/...`) en open een pull request.
- CI (format, lint, typecheck, tests, build) moet groen zijn voor een merge.
- Merge bij voorkeur met _squash_ of _rebase_ zodat de historie lineair blijft.

## Commits

We gebruiken [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(sim): voeg bootgolven toe aan de solver
fix(geo): corrigeer ringvolgorde bij multipolygonen
docs: beschrijf de modelaannames
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`.
Scopes volgen de mappen in `src/`: `sim`, `geo`, `boats`, `levels`, `ui`, plus `server`.

## Lokaal controleren

```bash
pnpm install
pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm test && pnpm run build
```
