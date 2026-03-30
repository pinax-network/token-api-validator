-- Pre-computed regression classifications, populated after each run.
-- Source of truth for regression logic remains in the regression_status view (020).
-- To update methodology: update the view, TRUNCATE this table, backfill with:
--   INSERT INTO regression_materialized SELECT * FROM regression_status
CREATE TABLE IF NOT EXISTS validation.regression_materialized (
    run_at           DateTime,
    domain           String,
    network          String,
    contract         String,
    symbol           String,
    field            String,
    entity           String,
    provider         String,
    our_value        Nullable(String),
    reference_value  Nullable(String),
    relative_diff    Nullable(Float64),
    tolerance        Float64,
    our_url          String,
    reference_url    String,
    is_regression    Bool
) ENGINE = ReplicatedReplacingMergeTree()
ORDER BY (run_at, domain, network, contract, field, entity, provider)
TTL run_at + INTERVAL 180 DAY;
