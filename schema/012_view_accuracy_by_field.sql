-- Per-run accuracy broken down by domain and compared field.
CREATE OR REPLACE VIEW validation.accuracy_by_field AS
SELECT
    run_at,
    domain,
    field,
    if(countIf(is_comparable) = 0, NULL,
        countIf(is_match AND is_comparable) / countIf(is_comparable)
    ) AS accuracy
FROM validation.comparison_enriched
GROUP BY run_at, domain, field;
