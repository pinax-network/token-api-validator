-- Per-run accuracy broken down by compared field (decimals, symbol, total_supply).
CREATE OR REPLACE VIEW validation.run_accuracy_by_field AS
SELECT
    run_at,
    field,
    if(countIf(is_comparable) = 0, NULL,
        countIf(is_match AND is_comparable) / countIf(is_comparable)
    ) AS accuracy
FROM validation.comparison_enriched
GROUP BY run_at, field;
