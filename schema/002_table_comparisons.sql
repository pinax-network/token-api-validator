CREATE TABLE IF NOT EXISTS validation.comparisons (
    run_id               String              COMMENT 'References runs.run_id',
    run_at               DateTime            COMMENT 'When the parent run started',
    domain               String              COMMENT 'Validation domain (metadata or balance)',
    network              String              COMMENT 'Token API network ID (e.g. mainnet, bsc)',
    contract             String              COMMENT 'Token contract address',
    symbol               String              COMMENT 'Token symbol from tokens.json (for labeling)',
    field                String              COMMENT 'Compared field (decimals, symbol, total_supply, balance)',
    entity               String DEFAULT ''   COMMENT 'Domain-specific subject key: holder address (balance), empty (metadata)',
    our_value            Nullable(String)    COMMENT 'Value from our Token API',
    reference_value      Nullable(String)    COMMENT 'Value from the reference provider',
    provider             String              COMMENT 'Reference source used (blockscout, etherscan, or rpc)',
    relative_diff        Nullable(Float64)   COMMENT 'Relative difference for numeric fields (null for exact)',
    is_match             Bool                COMMENT 'Whether values matched within configured tolerance',
    tolerance            Float64             COMMENT 'Tolerance threshold applied (0 for exact, e.g. 0.01 for 1%)',
    our_fetched_at       DateTime            COMMENT 'When our API was queried',
    reference_fetched_at DateTime            COMMENT 'When the reference provider was queried',
    our_block_timestamp  Nullable(DateTime)  COMMENT 'Last indexed block timestamp from our API (for freshness)',
    reference_block_timestamp Nullable(DateTime) COMMENT 'Block timestamp from the reference provider (for lag estimation)',
    our_url              String              COMMENT 'Full request URL used for our API query',
    reference_url        String              COMMENT 'Full request URL used for the reference query',
    our_null_reason      Nullable(String)    COMMENT 'Why our value is null (empty, timeout, not_found, etc.)',
    reference_null_reason Nullable(String)   COMMENT 'Why reference value is null (empty, paid_plan_required, etc.)'
) ENGINE = ReplicatedMergeTree()
ORDER BY (run_at, domain, network, contract, field, entity)
TTL run_at + INTERVAL 180 DAY;
