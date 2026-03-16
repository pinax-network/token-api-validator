-- All comparisons with computed booleans.
-- is_comparable: both sides returned data (eligible for accuracy metrics)
-- is_fresh: our data was indexed within 5 minutes of the run
CREATE OR REPLACE VIEW validation.comparison_enriched AS
SELECT
    *,
    (our_null_reason IS NULL OR our_null_reason = 'empty')
        AND (reference_null_reason IS NULL OR reference_null_reason = 'empty')
        AS is_comparable,
    our_block_timestamp >= run_at - INTERVAL 5 MINUTE
        AS is_fresh
FROM validation.comparisons;
