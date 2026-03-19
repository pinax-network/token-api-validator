# Token API Validator

Validation service that compares Token API responses against reference providers (block explorers and on-chain RPC) to track data accuracy over time.

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
bun run test             # run tests
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
- `src/validator.ts` — Orchestrates a validation run (sequential networks, sequential tokens)
- `src/comparator.ts` — `compareField()` (universal comparison primitive)
- `src/providers/token-api.ts` — Fetches our Token API (metadata + balances)
- `src/providers/blockscout.ts` — Fetches from Blockscout explorers (metadata + balances)
- `src/providers/etherscan.ts` — Fetches from Etherscan V2 unified API (metadata + balances)
- `src/providers/rpc.ts` — Reads ERC-20 metadata directly from smart contracts via JSON-RPC `eth_call`
- `src/registry.ts` — Graph Network Registry sync for reference provider discovery
- `src/metrics.ts` — Prometheus metric definitions (shared across modules)
- `src/storage/clickhouse.ts` — ClickHouse client, insert/query functions
- `src/storage/types.ts` — `ComparisonRecord`, `RunRecord` interfaces, `tallyCounts()` helper
- `src/scheduler.ts` — croner-based cron scheduling
- `src/utils/retry.ts` — Shared retry with exponential backoff
- `src/utils/normalize.ts` — String normalization, `scaleDown` (raw → human-readable), `scaleUp` (human-readable → raw)
- `src/providers/types.ts` — Shared interfaces (`Provider`, `ComparableEntry`, `ProviderResult`, `NullReason`, `TokenReference`) + `httpStatusToNullReason()`
- `tokens.json` — Reference token list (generated, committed)
- `schema/` — ClickHouse SQL definitions (tables and views), executed by `init-db`
- `scripts/` — One-off scripts (not part of runtime)

## Validation domains

The validator compares two **validation domains**: metadata and balances. The domain abstraction works at three layers:

- **Comparator + validator** (inside the abstraction): `compareField()` is the universal comparison primitive — it works on any field in any domain. Providers return `ProviderResult` (list of `ComparableEntry`), the validator joins two results by `(field, entity)` key to produce `ComparisonRecord[]`. The validator loops over domain fetchers — adding a domain means adding one entry to the loop. The comparator, join logic, and counting code don't change.
- **Providers** (outside the abstraction): all providers implement the `Provider` interface (`fetchMetadata` + `fetchBalances`, both returning `ProviderResult`). Each domain has unique fetch patterns (batch metadata, paginated balances) but the return type is uniform. Providers normalize data representation (e.g. `scaleDown`/`scaleUp`) before returning entries.
- **Storage** (partially inside): a single unified `comparisons` table with `domain`/`field`/`entity` columns stores all comparison records. Domain-agnostic views (`comparison_enriched`, `run_metrics`, `regression_status`, etc.) include `domain` in their GROUP BY / PARTITION BY; queries filter with `WHERE domain = '...'`.

Providers normalize **data representation** (e.g. `scaleDown` converts raw integers to human-readable). The comparator normalizes **for comparison** (e.g. case-insensitive matching via `normalizeString`, driven by tolerance config). These responsibilities don't cross.

## Key conventions

- Tolerances are defined in `src/validator.ts` as `TOLERANCES: Record<string, FieldTolerance>`. Adding a field means adding one entry — any domain, any field. Balance comparisons use ±1% relative tolerance, same as `total_supply`.
- Null reasons (`our_null_reason`, `reference_null_reason`) are tracked per-entry via `ComparableEntry.null_reason`. The `NullReason` type in `src/providers/types.ts` enumerates all valid values. Provider errors (rate_limited, forbidden, etc.) are excluded from accuracy; `empty` (provider succeeded but returned no data) counts as a mismatch. The `runs` table stores aggregate counts across all domains (`matches + mismatches + nulls = comparisons`); per-domain counts are computed from the `comparisons` table via views.
- `total_supply` is stored as string for big number precision, compared numerically with relative tolerance. Our API field is `circulating_supply` (misnamed, represents total supply). Reference providers normalize raw integers to human-readable via `scaleDown()` in their `fetchMetadata()` methods before returning to the comparator.
- Blockscout URLs, chain IDs, and RPC URLs are discovered via The Graph Network Registry (`@pinax/graph-networks-registry`), with hardcoded defaults as fallback. Etherscan uses the V2 unified endpoint (`api.etherscan.io/v2/api?chainid=...`) with a single API key across all chains. RPC URLs from the registry are internal service URLs (`*.rpc.service.pinax.network`); when `PINAX_RPC_API_KEY` is configured, `getRpcUrl()` transforms them to authenticated public URLs (`*.rpc.pinax.network/v1/{key}/`). Without the key, unauthenticated requests are rate-limited by the Pinax Caddy gateway.
- The `provider` column in comparisons records the actual reference provider used (`blockscout`, `etherscan`, or `rpc`), not a generic name. Request URLs are stored in `our_url` and `reference_url` for reproducibility — API keys are stripped before storage (Etherscan strips `apikey` query param, RPC strips `/v1/{key}` path segment). Error messages from viem are also sanitized via `sanitizeError()` before leaving the RPC provider to prevent key leakage in logs.
- `TOKEN_API_JWT` is a bearer JWT, not an API key.
- Etherscan V2 uses `token/tokeninfo` for metadata and `token/topholders` for balances (both require paid plan). `topholders` is throttled to 2 calls/sec regardless of plan tier. Error parsing in `parseEtherscanError()` uses case-insensitive `includes()` matching to handle inconsistent error messages across chains (Etherscan, BSCScan, Snowtrace all return slightly different wording via the V2 unified endpoint).
- All available reference providers are queried per network (not just a preferred one). Token API is batch-fetched per network (comma-separated `contract` param, chunked at 100, with individual fallback on HTTP error); reference provider fetches are parallel within a token (Blockscout and Etherscan are independent services). Networks are processed sequentially to avoid Etherscan's global 2 calls/sec rate limit on `topholders`. HTTP 429 responses are retried with exponential backoff via `withRetry`'s `shouldRetry` predicate. On exhaustion, the response is returned (not thrown), so the provider's normal error handling maps it to `null_reason: 'rate_limited'`. Network errors (socket failures, DNS) still throw on exhaustion and surface as run-level errors.

## Methodology and metric definitions

- `docs/methodology.md` — Source of truth for what is compared, why, and how metrics are defined. Must be updated when comparison logic, thresholds, or metric calculations change.
- `schema/*.sql` — Source of truth for metric computations. Thresholds (tolerance, freshness window, regression window) are encoded here. Both Grafana dashboards and the `/report` endpoint query these views.

## Validation

After any code change, run `bun test && bun run typecheck && bunx biome check .` to verify. Use `bunx biome check --write .` to auto-fix formatting.

## ClickHouse

- Schema defined in `schema/*.sql` — tables and views, executed in lexicographic order by `bun run init-db` (idempotent)
- App does NOT auto-create tables — run `init-db` before first run
- Connection details configured via env vars (see `.env.example`)
