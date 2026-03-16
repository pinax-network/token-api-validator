-- Per-run, per-domain accuracy, adjusted accuracy, coverage, and comparison counts.
CREATE OR REPLACE VIEW validation.run_metrics AS
SELECT
    run_at,
    domain,
    countIf(is_match AND is_comparable) AS matches,
    countIf(NOT is_match AND is_comparable) AS mismatches,
    countIf(NOT is_comparable) AS nulls,
    countIf(is_comparable) AS comparable,
    if(countIf(is_comparable) = 0, NULL,
        countIf(is_match AND is_comparable) / countIf(is_comparable)
    ) AS accuracy,
    if(countIf(is_comparable AND is_fresh) = 0, NULL,
        countIf(is_match AND is_comparable AND is_fresh) / countIf(is_comparable AND is_fresh)
    ) AS adjusted_accuracy,
    if(count() = 0, NULL,
        countIf(is_comparable) / count()
    ) AS coverage,
    count() AS total_comparisons
FROM validation.comparison_enriched
GROUP BY run_at, domain;
