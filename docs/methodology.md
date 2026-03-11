# Validation Methodology

This document describes how the Token API Validator measures data accuracy and the rationale behind its design choices.

## Thresholds

| Threshold | Value | Rationale |
|-----------|-------|-----------|
| `total_supply` tolerance | ±1% | Tight enough to catch real divergence, loose enough for timing differences between queries |
| Freshness window | 5 minutes | Filters out mismatches caused by indexing lag rather than actual data issues |
| Regression window | 5 runs | Rolling window over which relative field mismatches are evaluated |
| Regression threshold | ≥3 mismatches in window | Minimum mismatches to classify as a sustained regression, filtering out one-off timing noise |

These thresholds are encoded in ClickHouse views (`schema/`) which serve as the single source of truth for Grafana dashboards and the report endpoint.

## What is compared

The validator compares Token API responses against reference blockchain explorers (Blockscout, Etherscan) for a curated set of tokens derived from the top 500 coins by global market cap.

### Fields

Each field has a **field type** that determines how it is compared and how regressions are tracked:

- **Exact**: Values must match precisely after normalization (if applicable). These fields are immutable on-chain — any mismatch is a real data quality issue.
- **Relative**: Values are compared numerically with a tolerance threshold. Small differences are expected due to timing between queries.

| Field | Field Type | Tolerance | Notes |
|-------|-----------|-----------|-------|
| `decimals` | Exact | 0 | Must be identical. Never changes for a token. |
| `symbol` | Exact (normalized) | 0 | Compared after lowercase + trim + whitespace collapse. |
| `total_supply` | Relative | ±1% | Compared as numbers. Slight differences expected due to timing. |

High-velocity tokens (e.g., stablecoins like USDC) may occasionally cross the `total_supply` tolerance without indicating a real issue; the regression tracking methodology (see below) filters out this noise.

### Excluded fields

| Field | Reason |
|-------|--------|
| `name` | Not comparable across sources. Our API returns raw on-chain `name()` values (e.g., "Wrapped BTC"), while Blockscout displays CoinGecko-curated marketing names (e.g., "Wrapped Bitcoin"). This is a data philosophy difference, not a quality issue. |

### Reference providers

| Provider | API key required | Fields available |
|----------|-----------------|-----------------|
| Blockscout | No | symbol, decimals, total_supply |
| Etherscan V2 (free tier) | Yes (free registration) | total_supply |
| Etherscan V2 (Pro) | Yes (paid) | symbol, decimals, total_supply |

Etherscan Pro is tried first. If unavailable, the free tier provides total supply only. The reason for partial availability is recorded per-field, so coverage metrics accurately reflect the gap rather than silently dropping those fields.

Explorer URLs are resolved from [The Graph Network Registry](https://networks-registry.thegraph.com/TheGraphNetworksRegistry.json). All available explorers are queried per network (see [Reference provider selection](#reference-provider-selection)).

### Reference token set

The reference set is the top 500 coins by **global** market cap from CoinGecko, not per-network. This is deliberate: global market cap captures the most economically significant tokens, and these high-value tokens tend to be deployed across multiple chains. A per-network approach would over-index on network-specific tokens (e.g., meme coins popular on one chain) while potentially missing major cross-chain tokens that matter most to users.

Since a single coin can be deployed on multiple chains (e.g., USDT exists on mainnet, BSC, Polygon, Arbitrum, etc.), each chain deployment becomes a separate token entry. This means 500 coins typically expand to 700+ token-network pairs, providing broader coverage and surfacing per-chain data quality differences for the same token.

## Metrics

### Accuracy

**Definition**: Of the fields not excluded by provider errors, what percentage matched within tolerance?

```
Accuracy = matches / (matches + mismatches)
```

Only comparisons where a provider error caused the null (e.g., rate limiting, timeout, forbidden) are excluded from accuracy. Fields where a provider responded successfully but returned no data (`empty`) are counted as mismatches — missing data from a healthy provider is a data quality issue.

### Adjusted Accuracy

Same as accuracy, but filtered to comparisons where our data was fresh (indexed within the freshness window). This filters out mismatches caused by indexing pipeline lag rather than actual data quality issues.

```
Adjusted Accuracy = matches / (matches + mismatches)
  WHERE data is fresh
```

When the gap between Overall Accuracy and Adjusted Accuracy exceeds ~5 percentage points, it suggests indexing lag is the primary driver of mismatches, not underlying data issues.

### Coverage

**Definition**: Of all attempted comparisons, what percentage had data from both sides?

```
Coverage = (matches + mismatches) / total_comparisons
```

Low coverage means either our API or the reference provider is not returning data for many tokens/fields.

### Run totals invariant

Each run tracks `matches`, `mismatches`, and `nulls` as separate counters. These always sum to the total:

```
matches + mismatches + nulls = comparisons
```

With multiple reference providers, a single token may produce multiple comparison rows per field (one per available explorer). Run totals reflect all comparison rows across all providers.

### Freshness

**Definition**: How far behind is our indexed data compared to the current time?

Tracked per token per network. When freshness lag increases, accuracy may temporarily drop — this is expected and does not indicate a data quality issue.

## Null handling

When either our API or the reference provider returns no data for a field:
- If the null was caused by a **provider error** (rate limiting, timeout, forbidden, etc.): excluded from accuracy, counted toward coverage as "non-comparable"
- If the reason is **`empty`** (provider responded successfully but had no data): counted as a **mismatch** in accuracy — this surfaces missing data as a data quality issue

### Null reasons

Null reasons are tracked **per-field**, not per-request. A single provider response may succeed for some fields and fail for others (e.g., Etherscan free tier returns `total_supply` but not `decimals` or `symbol`).

| Reason | Meaning |
|--------|---------|
| `empty` | Provider responded successfully but returned no data for this field (counted as mismatch) |
| `not_found` | Token not found on this provider |
| `forbidden` | Authentication failure |
| `timeout` | Request timed out |
| `rate_limited` | Rate limit exceeded (after retries exhausted) |
| `paid_plan_required` | Field requires a paid API plan |
| `server_error` | Unexpected provider error |

## Data normalization

### `total_supply`

Our Token API returns total supply as a human-readable decimal number (e.g., `96119620139.51`). Explorers return raw unscaled integers (e.g., `96118349783467415` for a 6-decimal token). Before comparison, the reference value is normalized by dividing by `10^decimals` to produce the same human-readable representation.

### `symbol`

Compared after normalization: lowercase, trim whitespace, collapse internal whitespace. This avoids false mismatches from casing or spacing differences.

## Reference provider selection

For each network, the validator queries **all available** reference explorers and produces independent comparison rows per provider. This means a single token may have comparison rows from both Blockscout and Etherscan in the same run.

Available explorers per network:
- **Blockscout** — if a Blockscout API URL is known for the network
- **Etherscan V2** — if the network has a known EVM chain ID

If no explorers are available for a network, it is skipped entirely.

## Regression tracking

Regressions track comparisons that were previously matching but started mismatching. Regressions are tracked independently per provider — a token may regress against Etherscan while remaining stable against Blockscout (or vice versa), since each explorer has its own indexing pipeline and timing characteristics.

The detection method differs by field type to account for natural variance:

### Exact fields (decimals, symbol)

Any mismatch in the current run counts as a regression. These fields are immutable on-chain, so every mismatch represents a real data quality change.

### Relative fields (total_supply)

One-off flips are expected due to timing differences between our API and the reference provider. To filter out this noise, regressions are only counted when a token enters the **sustained mismatch** zone: mismatched at or above the regression threshold within the regression window (see [Thresholds](#thresholds)). This prevents natural variance around the tolerance boundary from producing false regression signals.

The current thresholds are a pragmatic starting point. With sufficient historical data, a more statistically rigorous approach would compute per-field (and potentially per-network) baseline mismatch rates and flag deviations from that baseline.

Comparisons excluded due to provider errors are excluded from regression tracking. Comparisons with `empty` reason participate in regression tracking as mismatches.

## Known limitations

1. **Sample-based**: Only validates tokens derived from the top 500 coins by global market cap. Accuracy for long-tail tokens may differ.
2. **Timing differences**: Our API and the reference provider are queried moments apart. For rapidly changing fields (like `total_supply` during high activity), small differences are expected.
3. **Free tier constraints**: Etherscan free tier only provides total supply; symbol and decimals require a paid plan. Some chains are excluded entirely on the free tier (e.g., BSC). Blockscout is free and provides all fields where available.
4. **Normalization coupling**: The validator assumes specific data formats from our API (e.g., how `total_supply` is scaled). If our API changes its representation, the validator may need updating — but it will surface this change as an accuracy drop.
5. **Sustained threshold cold start**: The sustained mismatch detection requires a minimum number of runs of history. Early runs may show inflated regression counts as tokens first enter the sustained zone.
