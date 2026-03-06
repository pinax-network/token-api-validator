# Token API Validator

Validation service that tracks the accuracy of [Token API](https://token-api.thegraph.com) data by comparing responses against reference providers (Etherscan, Blockscout).

Runs on a schedule, stores results in ClickHouse, and exposes Prometheus metrics for Grafana dashboards.

> **Methodology**: See [docs/methodology.md](docs/methodology.md) for detailed documentation on what is compared, tolerance thresholds, accuracy/coverage metrics, and known limitations.

## Quick Start

```bash
# Install dependencies
bun install

# Copy and configure environment
cp .env.example .env

# Generate reference token list (requires COINGECKO_API_KEY)
bun run fetch-tokens

# Create ClickHouse tables
bun run init-db

# Start the service
bun run dev
```

## Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | Liveness check |
| `/trigger` | POST | Trigger manual validation run |
| `/status` | GET | Latest run summary |
| `/metrics` | GET | Prometheus metrics |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLICKHOUSE_URL` | **Yes** | — | ClickHouse HTTP endpoint |
| `CLICKHOUSE_USERNAME` | **Yes** | — | ClickHouse user |
| `CLICKHOUSE_PASSWORD` | **Yes** | — | ClickHouse password |
| `CLICKHOUSE_DATABASE` | No | `validation` | ClickHouse database name |
| `TOKEN_API_BASE_URL` | **Yes** | — | Token API base URL |
| `TOKEN_API_JWT` | **Yes** | — | Bearer JWT for Token API authentication ([quick start](https://thegraph.com/docs/en/token-api/quick-start/)) |
| `ETHERSCAN_API_KEY` | No | — | Etherscan V2 API key (single key, works across all chains) |
| `COINGECKO_API_KEY` | No | — | CoinGecko API key (only used by `fetch-tokens` script, not at runtime) |
| `CRON_SCHEDULE` | No | `0 */6 * * *` | Validation run cron schedule |
| `RATE_LIMIT_MS` | No | `500` | Delay between provider requests within a network (ms) |
| `RETRY_MAX_ATTEMPTS` | No | `3` | Max retry attempts for failed requests |
| `RETRY_BASE_DELAY_MS` | No | `1000` | Base delay for exponential backoff (ms) |
| `PORT` | No | `3000` | HTTP server port |
| `VERBOSE` | No | `true` | Enable verbose logging |
| `PRETTY_LOGGING` | No | `false` | Pretty-print log output |

## Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `validator_runs_total` | Counter | `trigger`, `status` | Validation runs completed |
| `validator_run_duration_seconds` | Histogram | — | Run wall-clock duration |
| `validator_tokens_checked_total` | Counter | `network` | Tokens checked across runs |
| `validator_provider_requests_total` | Counter | `provider`, `network`, `status` | Provider API requests |
| `validator_provider_request_duration_seconds` | Histogram | `provider` | Provider request duration |
| `validator_clickhouse_writes_total` | Counter | `status` | ClickHouse write operations |

Default process metrics (memory, CPU, event loop lag) are also exported.

## ClickHouse Setup

The service requires a ClickHouse database and user. Required grants:

```sql
-- Runtime (INSERT comparisons/runs, SELECT for /status endpoint)
GRANT INSERT, SELECT ON validation.* TO validator;

-- Table management (init-db.ts script: CREATE/DROP tables)
GRANT CREATE TABLE, DROP TABLE ON validation.* TO validator;
GRANT TABLE ENGINE ON MergeTree TO validator;
```

### Table Schemas

Both tables use `MergeTree` engine with a configurable TTL (default 180 days). Run `bun run init-db` to create them.

```sql
CREATE TABLE validation.runs (
    run_id         String                              COMMENT 'Unique UUID for this validation run',
    started_at     DateTime                            COMMENT 'When the run began',
    completed_at   Nullable(DateTime)                  COMMENT 'When the run finished (null if still running)',
    trigger        Enum('scheduled', 'manual')         COMMENT 'What initiated the run',
    tokens_checked UInt32                              COMMENT 'Number of tokens successfully validated',
    comparisons    UInt32                              COMMENT 'Total per-field comparison records produced',
    matches        UInt32                              COMMENT 'Comparisons where values matched within tolerance',
    mismatches     UInt32                              COMMENT 'Comparisons where values differed beyond tolerance',
    nulls          UInt32                              COMMENT 'Comparisons where one or both sides returned null',
    errors         UInt32                              COMMENT 'Tokens that failed to validate (fetch or compare error)',
    status         Enum('success', 'partial', 'failed') COMMENT 'Overall run outcome',
    error_detail   Nullable(String)                    COMMENT 'Error description when status is partial or failed'
) ENGINE = ReplicatedMergeTree()
ORDER BY started_at
TTL started_at + INTERVAL 180 DAY
-- Invariant: matches + mismatches + nulls = comparisons

CREATE TABLE validation.comparisons (
    run_id                String              COMMENT 'References runs.run_id',
    run_at                DateTime            COMMENT 'When the parent run started',
    network               String              COMMENT 'Network ID (e.g. mainnet, bsc)',
    contract              String              COMMENT 'Token contract address',
    symbol                String              COMMENT 'Token symbol from tokens.json',
    field                 String              COMMENT 'Metadata field compared (decimals, symbol, total_supply)',
    our_value             Nullable(String)    COMMENT 'Value from our Token API',
    reference_value       Nullable(String)    COMMENT 'Value from the reference provider',
    provider              String              COMMENT 'Reference source used (blockscout or etherscan)',
    relative_diff         Nullable(Float64)   COMMENT 'Relative difference for numeric fields (null for exact)',
    is_match              Bool                COMMENT 'Whether values matched within configured tolerance',
    tolerance             Float64             COMMENT 'Tolerance threshold applied (0 for exact, e.g. 0.01 for 1%)',
    our_fetched_at        DateTime            COMMENT 'When our API was queried',
    reference_fetched_at  DateTime            COMMENT 'When the reference provider was queried',
    our_block_timestamp   Nullable(DateTime)  COMMENT 'Last indexed block timestamp from our API (for freshness)',
    our_url               String              COMMENT 'Full request URL used for our API query',
    reference_url         String              COMMENT 'Full request URL used for the reference query',
    our_null_reason       Nullable(String)    COMMENT 'Why our value is null (empty, rate_limited, etc.)',
    reference_null_reason Nullable(String)    COMMENT 'Why reference value is null (paid_plan_required, etc.)'
) ENGINE = ReplicatedMergeTree()
ORDER BY (run_at, network, contract, field)
TTL run_at + INTERVAL 180 DAY
```

## Scripts

- `bun run fetch-tokens` — Refresh `tokens.json` from CoinGecko (top tokens by market cap)
- `bun run init-db` — Create ClickHouse tables (`--ttl 180` for TTL, `--drop` to recreate)

Blockscout URLs and chain IDs are resolved via [The Graph Network Registry](https://networks-registry.thegraph.com/TheGraphNetworksRegistry.json), synced at startup and before each run. Etherscan uses the [V2 unified API](https://docs.etherscan.io/etherscan-v2) (`api.etherscan.io/v2/api?chainid=...`) — a single API key works across all supported chains.
