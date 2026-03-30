# Validation Methodology

The Token API Validator measures data accuracy by comparing Token API responses against reference providers (block explorers and on-chain RPC). It validates two independent domains — **token metadata** and **holder balances** — each with its own storage, metrics, and regression tracking.

## Token Set

The reference set is the **top 500 coins by global market cap** from CoinGecko — not per-network. Global market cap captures the most economically significant tokens, which tend to be deployed across multiple chains. Since a single coin can exist on many chains (e.g., USDT on mainnet, BSC, Polygon, Arbitrum), each deployment is validated independently. This typically expands 500 coins into **700+ token-network pairs**.

## Reference Providers

| Provider | Networks | API key | Metadata fields | Balance fields |
|----------|----------|---------|-----------------|----------------|
| Blockscout | EVM | No | name, symbol, decimals, total_supply | holder balances (top holders) |
| Etherscan V2 | EVM | Yes (paid) | name, symbol, decimals, total_supply | holder balances (top holders) |
| RPC | EVM | No | name, symbol, decimals, total_supply | holder balances (via `balanceOf`) |
| Solana RPC | Solana | Yes (dRPC) | name, symbol, decimals, total_supply | holder balances (via `getTokenAccountBalance`) |
| Solscan | Solana | Yes (paid) | name, symbol, decimals, total_supply | holder balances (top holders) |

EVM explorer URLs and RPC URLs are resolved from [The Graph Network Registry](https://networks-registry.thegraph.com/TheGraphNetworksRegistry.json). **All available providers are queried per network** — a single token may produce comparison rows from multiple providers. Networks with no known provider are skipped.

Solana addresses are Base58 and case-sensitive (no lowercasing).

### RPC — on-chain ground truth

RPC reads ERC-20 metadata directly from smart contracts, providing on-chain ground truth for `name`, `symbol`, `decimals`, and `total_supply`. Unlike explorer APIs, these values come straight from the contract state at a known block.

Since our Token API data pipeline itself ingests from RPC, comparing Token API vs RPC isolates pipeline issues (indexing bugs, transformation errors) from source disagreements. RPC reads are pinned to the same block as Token API's last indexed block, so any mismatch is a real pipeline defect — not a timing artifact.

### Solana RPC — on-chain ground truth

The Solana RPC provider serves the same role as EVM RPC but for Solana: reading on-chain state directly rather than from an indexed API. Metadata fields (name, symbol, decimals, total_supply) come from the SPL token mint and Metaplex Token Metadata accounts. Balances are checked per holder address provided by Token API, matching the EVM RPC "check provided list" pattern.

---

## Validation Domains

Metadata and Balance are two independent validation domains. Both share:
- **Storage** — a single unified `comparisons` table with a `domain` column, plus domain-agnostic views that include `domain` in their GROUP BY / PARTITION BY
- **Token set, reference providers, null reason semantics, and thresholds model**
- **Views** — `comparison_enriched`, `run_metrics`, `accuracy_by_field`, `accuracy_by_network`, and `regression_status` all operate across domains; queries filter with `WHERE domain = '...'`
- **Regression tracking** — independent per domain (partitioned by `domain` in the regression view). The `regression_materialized` table caches pre-computed classifications after each run for dashboard performance; the `regression_status` view is the canonical methodology definition

### Entity column

Each comparison is uniquely identified by `(run_at, domain, network, contract, field, entity)`. The `entity` column is a generic string key that each domain populates with whatever identifies the comparison subject beyond the common dimensions:

| Domain | `entity` value | Example |
|--------|---------------|---------|
| metadata | empty string | `""` — the token itself is the subject |
| balance | holder address | `"0xdac17f..."` — a specific holder |

The `domain` column tells you how to interpret `entity`. No prefix or structured format is used — with two domains the values are unambiguous.

---

## Token Metadata

### Fields

| Field | Comparison | Notes |
|-------|-----------|-------|
| `name` | Exact match (normalized) | Lowercased, trimmed, whitespace collapsed before comparison. |
| `decimals` | Exact match | Immutable on-chain. Any mismatch is a real issue. |
| `symbol` | Exact match (normalized) | Lowercased, trimmed, whitespace collapsed before comparison. |
| `total_supply` | Numeric, ±1% tolerance | Reference providers return raw integers; providers normalize from raw to human-readable (via `scaleDown`) before comparison. |

---

## Balance Validation

### Approach

Validating every balance for every token is infeasible. Instead, balances are validated by sampling the **top 100 holders** per token from each reference provider. This captures the most economically significant accounts (exchanges, contracts, whales) and provides meaningful coverage without exhausting API budgets.

Holders are matched by address across both sides. Balance comparison only happens on the intersection — holders present on one side but not the other are tracked as a **coverage metric**, analogous to null reasons in metadata validation.

### Fields

| Field | Comparison | Notes |
|-------|-----------|-------|
| `balance` | Numeric, ±1% tolerance | Same tolerance and regression tracking as `total_supply`. Raw integer strings compared directly (no decimals scaling). |

---

## Metrics

Accuracy, coverage, and regression metrics are computed **independently per domain**. The formulas are the same for both metadata and balance validation.

### Accuracy

Of the comparable fields (excluding provider errors), what percentage matched?

```
Accuracy = matches / (matches + mismatches)
```

Provider errors (rate limiting, timeout, forbidden) are excluded. Successful responses that return no data (`empty`) count as **mismatches** — missing data from a healthy provider is a quality issue.

### Adjusted Accuracy

Same formula, filtered to comparisons where our data was **fresh** (indexed within 5 minutes of the run). This isolates real data quality issues from indexing pipeline lag.

A gap of >5pp between accuracy and adjusted accuracy suggests lag is the primary driver of mismatches.

### Coverage

Of all attempted comparisons, what percentage had data from both sides?

```
Coverage = comparable / total_comparisons
```

### Null Reasons

Tracked **per-entry** — each comparable entry carries its own null reason. A provider may succeed for some fields and fail for others.

| Reason | Meaning | Effect on metrics |
|--------|---------|-------------------|
| `empty` | Provider responded but returned no data | Counts as mismatch |
| `not_found` | Token not found | Excluded from accuracy |
| `rate_limited` | Rate limit exceeded after retries | Excluded from accuracy |
| `paid_plan_required` | Requires paid API plan | Excluded from accuracy |
| `forbidden` | Authentication failure | Excluded from accuracy |
| `timeout` | Request timed out | Excluded from accuracy |
| `server_error` | Unexpected error | Excluded from accuracy |

## Regression Tracking

Regressions identify comparisons that were matching but started mismatching, tracked independently per provider and per domain. The detection method varies by field type:

**Exact fields** (metadata only) — any mismatch is a regression (these values are immutable on-chain).

**Relative fields** (metadata `total_supply` and all balance comparisons) — one-off flips are expected due to timing. A regression is only flagged when a token mismatches in **≥3 of its last 5 runs** (sustained mismatch). The same threshold applies for clearing: a regression remains active until the window contains fewer than 3 mismatches. This means a token may still appear as a regression for a few runs after it starts matching again.

Provider errors are excluded from regression tracking. Successful empty responses participate as mismatches.

## Thresholds

| Threshold | Value | Rationale |
|-----------|-------|-----------|
| `total_supply` tolerance | ±1% | Catches real divergence while allowing for timing differences |
| `balance` tolerance | ±1% | Same tolerance as `total_supply` |
| Freshness window | 5 min | Filters mismatches caused by indexing lag |
| Regression window | 5 runs | Rolling window for sustained mismatch detection |
| Regression threshold | ≥3 in window | Minimum to classify as sustained, filtering one-off noise |

These are encoded in ClickHouse views (`schema/`) which serve as the single source of truth for both Grafana dashboards and the `/report` endpoint. The current values are a pragmatic starting point — with more historical data, per-field baseline mismatch rates could replace fixed thresholds.

## Known Limitations

1. **Sample-based** — only the top 500 coins by market cap. Long-tail token accuracy may differ.
2. **Timing** — our API and explorers are queried moments apart. High-velocity tokens (e.g., stablecoins) may cross the tolerance transiently.
3. **Explorer gaps** — Some chains (e.g., BSC) have no Blockscout instance, leaving only Etherscan. If the Etherscan plan lapses, affected chains lose all reference coverage.
4. **Cold start** — sustained mismatch detection needs ≥5 runs of history. Early runs may show inflated regression counts.
5. **Balance intersection** — only holders present on both sides are compared. If our API and a reference provider rank holders differently (e.g., due to timing), the intersection may be smaller than 100.
