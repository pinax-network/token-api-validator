# Validation Methodology

The Token API Validator measures data accuracy by comparing Token API responses against reference blockchain explorers. This document explains what is compared, how, and why.

## Token Set

The reference set is the **top 500 coins by global market cap** from CoinGecko — not per-network. Global market cap captures the most economically significant tokens, which tend to be deployed across multiple chains. Since a single coin can exist on many chains (e.g., USDT on mainnet, BSC, Polygon, Arbitrum), each deployment is validated independently. This typically expands 500 coins into **700+ token-network pairs**.

## Fields

| Field | Comparison | Notes |
|-------|-----------|-------|
| `decimals` | Exact match | Immutable on-chain. Any mismatch is a real issue. |
| `symbol` | Exact match (normalized) | Lowercased, trimmed, whitespace collapsed before comparison. |
| `total_supply` | Numeric, ±1% tolerance | Our API returns human-readable decimals; explorers return raw integers divided by `10^decimals` before comparison. |

`name` is intentionally excluded — our API returns the raw on-chain `name()` value (e.g., "Wrapped BTC") while explorers display curated marketing names (e.g., "Wrapped Bitcoin"). This is a data philosophy difference, not a quality issue.

## Reference Providers

| Provider | API key | Fields |
|----------|---------|--------|
| Blockscout | No | symbol, decimals, total_supply |
| Etherscan V2 (free) | Yes (free) | total_supply only |
| Etherscan V2 (Pro) | Yes (paid) | symbol, decimals, total_supply |

Explorer URLs are resolved from [The Graph Network Registry](https://networks-registry.thegraph.com/TheGraphNetworksRegistry.json). **All available explorers are queried per network** — a single token may produce comparison rows from both Blockscout and Etherscan. Networks with no known explorer are skipped.

Etherscan Pro is tried first; if unavailable, the free tier provides total supply only. Partial availability is recorded per-field so coverage metrics reflect the gap accurately.

## Metrics

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

Tracked **per-field**, not per-request — a provider may succeed for some fields and fail for others.

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

Regressions identify comparisons that were matching but started mismatching, tracked independently per provider. The detection method varies by field type:

**Exact fields** — any mismatch is a regression (these values are immutable on-chain).

**Relative fields** — one-off flips are expected due to timing. A regression is only flagged when a token mismatches in **≥3 of its last 5 runs** (sustained mismatch). This filters out natural variance around the tolerance boundary.

Provider errors are excluded from regression tracking. Successful empty responses participate as mismatches.

## Thresholds

| Threshold | Value | Rationale |
|-----------|-------|-----------|
| `total_supply` tolerance | ±1% | Catches real divergence while allowing for timing differences |
| Freshness window | 5 min | Filters mismatches caused by indexing lag |
| Regression window | 5 runs | Rolling window for sustained mismatch detection |
| Regression threshold | ≥3 in window | Minimum to classify as sustained, filtering one-off noise |

These are encoded in ClickHouse views (`schema/`) which serve as the single source of truth for both Grafana dashboards and the `/report` endpoint. The current values are a pragmatic starting point — with more historical data, per-field baseline mismatch rates could replace fixed thresholds.

## Known Limitations

1. **Sample-based** — only the top 500 coins by market cap. Long-tail token accuracy may differ.
2. **Timing** — our API and explorers are queried moments apart. High-velocity tokens (e.g., stablecoins) may cross the tolerance transiently.
3. **Free tier gaps** — Etherscan free tier only provides total supply. Some chains (e.g., BSC) have no Blockscout, leaving only Etherscan.
4. **Cold start** — sustained mismatch detection needs ≥5 runs of history. Early runs may show inflated regression counts.
