-- Regression classification for every comparable comparison.
-- Exact fields (tolerance = 0): a regression if the current run mismatches.
-- Relative fields (tolerance > 0): a regression if ≥3 of the last 5 runs mismatched.
CREATE OR REPLACE VIEW validation.regression_status AS
SELECT
    run_at, network, contract, symbol, field, provider,
    our_value, reference_value, relative_diff, tolerance,
    our_url, reference_url,
    if(tolerance = 0,
        NOT is_match,
        countIf(NOT is_match) OVER w >= 3 AND count() OVER w >= 3
    ) AS is_regression
FROM validation.comparison_enriched
WHERE is_comparable
WINDOW w AS (
    PARTITION BY network, contract, field, provider
    ORDER BY run_at
    ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
);
