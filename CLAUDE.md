# Token API Validator

Validation service that compares Token API responses against reference providers (block explorers) to track data accuracy over time.

## Stack

- Runtime: Bun + TypeScript
- Framework: Hono (HTTP server)
- Storage: ClickHouse (`validation` database)
- Metrics: prom-client (Prometheus format, scraped by VictoriaMetrics)
- Scheduling: croner (in-app cron)

## Commands

```bash
bun install              # install dependencies
bun run dev              # start with --watch
bun run start            # production start
bun run typecheck        # tsc --noEmit
bun run lint             # biome check
bun run fetch-tokens     # refresh tokens.json from CoinGecko (needs COINGECKO_API_KEY)
bun run init-db          # create ClickHouse tables and views (needs CH credentials)
```

## Versioning

Use `bun pm version <major|minor|patch>` to bump the version — it updates `package.json` and creates a git tag in one step. Push the tag with `git push --tags` after.

## Architecture

- `src/index.ts` — Hono HTTP server + scheduler startup
- `src/config.ts` — Zod-validated env config
- `src/validator.ts` — Orchestrates a validation run (parallel networks, sequential tokens)
- `src/comparator.ts` — Tolerance definitions and comparison logic
- `src/providers/token-api.ts` — Fetches our Token API
- `src/providers/blockscout.ts` — Fetches from Blockscout explorers
- `src/providers/etherscan.ts` — Fetches from Etherscan V2 unified API
- `src/registry.ts` — Graph Network Registry sync for reference provider discovery
- `src/metrics.ts` — Prometheus metric definitions (shared across modules)
- `src/storage/clickhouse.ts` — ClickHouse client, insert/query functions
- `src/scheduler.ts` — croner-based cron scheduling
- `src/utils/retry.ts` — Shared retry with exponential backoff
- `src/utils/normalize.ts` — String normalization + total supply scaling (raw integer → human-readable)
- `src/providers/types.ts` — Shared interfaces (`TokenMetadata`, `ProviderResult`, `NullReason`, etc.) + `emptyMetadata()`, `allFieldsNull()`, `httpStatusToNullReason()`
- `tokens.json` — Reference token list (generated, committed)
- `schema/` — ClickHouse SQL definitions (tables and views), executed by `init-db`
- `scripts/` — One-off scripts (not part of runtime)

## Key conventions

- Tolerances are defined in `src/comparator.ts` as `Record<keyof TokenMetadata, FieldTolerance>`. Adding a field to `TokenMetadata` requires a corresponding tolerance entry (enforced at compile time). `name` is intentionally excluded — see `docs/methodology.md` for rationale.
- Null reasons (`our_null_reason`, `reference_null_reason`) are tracked **per-field** — a provider may succeed for some fields and fail for others (e.g., Etherscan free tier returns total_supply but not decimals/symbol). The `NullReason` type in `src/providers/types.ts` enumerates all valid values. `isNullComparison()` in the comparator checks null reasons (not values) to decide bucketing: provider errors (rate_limited, forbidden, etc.) are excluded from accuracy; `empty` (provider succeeded but returned no data) counts as a mismatch. The `runs` table stores `nulls` alongside `matches` and `mismatches` so that `matches + mismatches + nulls = comparisons`.
- `total_supply` is stored as string for big number precision, compared numerically with relative tolerance. Our API field is `circulating_supply` (misnamed, represents total supply). Reference providers return raw unscaled integers — normalization to human-readable happens in the comparator via `scaleDown()`.
- Blockscout URLs and chain IDs are discovered via The Graph Network Registry (`@pinax/graph-networks-registry`), with hardcoded defaults as fallback. Etherscan uses the V2 unified endpoint (`api.etherscan.io/v2/api?chainid=...`) with a single API key across all chains.
- The `provider` column in comparisons records the actual reference provider used (`blockscout` or `etherscan`), not a generic name. Request URLs are stored in `our_url` and `reference_url` for reproducibility — API keys are stripped before storage.
- `TOKEN_API_JWT` is a bearer JWT, not an API key.
- Etherscan V2 tries `token/tokeninfo` (Pro) first for all fields; on failure (e.g. `paid_plan_required`), falls back to `stats/tokensupply` (free) for total_supply only. Error parsing in `parseEtherscanError()` matches exact documented error strings from https://docs.etherscan.io/resources/common-error-messages — update that reference when modifying it.
- All available reference providers are queried per network (not just a preferred one). Token API is batch-fetched per network (comma-separated `contract` param, chunked at 100, with individual fallback on HTTP error); reference provider fetches are parallel within a token (Blockscout and Etherscan are independent services). Rate limiting is per-network (sequential within network, parallel across networks). HTTP 429 responses are retried with exponential backoff via `withRetry`'s `shouldRetry` predicate. On exhaustion, the response is returned (not thrown), so the provider's normal error handling maps it to `null_reason: 'rate_limited'`. Network errors (socket failures, DNS) still throw on exhaustion and surface as run-level errors.

## Methodology and metric definitions

- `docs/methodology.md` — Source of truth for what is compared, why, and how metrics are defined. Must be updated when comparison logic, thresholds, or metric calculations change.
- `schema/*.sql` — Source of truth for metric computations. Thresholds (tolerance, freshness window, regression window) are encoded here. Both Grafana dashboards and the `/report` endpoint query these views.

## Validation

After any code change, run `bun run typecheck && bunx biome check .` to verify. Use `bunx biome check --write .` to auto-fix formatting.

## ClickHouse

- Schema defined in `schema/*.sql` — tables and views, executed in lexicographic order by `bun run init-db` (idempotent)
- App does NOT auto-create tables — run `init-db` before first run
- Connection details configured via env vars (see `.env.example`)
