CREATE TABLE IF NOT EXISTS validation.runs (
    run_id         String    COMMENT 'Unique UUID for this validation run',
    started_at     DateTime  COMMENT 'When the run began',
    completed_at   Nullable(DateTime) COMMENT 'When the run finished (null if still running)',
    trigger        Enum('scheduled', 'manual') COMMENT 'What initiated the run',
    tokens_checked UInt32    COMMENT 'Number of tokens successfully validated',
    comparisons    UInt32    COMMENT 'Total per-field comparison records produced',
    matches        UInt32    COMMENT 'Comparisons where values matched within tolerance',
    mismatches     UInt32    COMMENT 'Comparisons where values differed beyond tolerance',
    nulls          UInt32    COMMENT 'Comparisons excluded from accuracy due to provider errors',
    errors         UInt32    COMMENT 'Tokens that failed to validate (fetch or compare error)',
    status         Enum('success', 'partial', 'failed') COMMENT 'Overall run outcome',
    error_detail   Nullable(String) COMMENT 'Error description when status is partial or failed'
) ENGINE = ReplicatedMergeTree()
ORDER BY started_at
TTL started_at + INTERVAL 180 DAY;
