-- Per-run accuracy broken down by network (mainnet, bsc, etc.).
CREATE OR REPLACE VIEW validation.run_accuracy_by_network AS
SELECT
    run_at,
    network,
    if(countIf(is_comparable) = 0, NULL,
        countIf(is_match AND is_comparable) / countIf(is_comparable)
    ) AS accuracy
FROM validation.comparison_enriched
GROUP BY run_at, network;
