import { compareField, type FieldTolerance } from './comparator.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { runDuration, runsTotal, tokensChecked } from './metrics.js';
import { BlockscoutProvider } from './providers/blockscout.js';
import { EtherscanProvider } from './providers/etherscan.js';
import { TokenApiProvider, type TokenApiResult } from './providers/token-api.js';
import type { BalancesResult, MetadataResult, TokenMetadata, TokenReference } from './providers/types.js';
import { getAvailableProviders, syncRegistry } from './registry.js';
import {
    type ComparisonRecord,
    insertComparisons,
    insertRun,
    type RunRecord,
    tallyCounts,
} from './storage/clickhouse.js';

const TOLERANCES: Record<string, FieldTolerance> = {
    name: { type: 'exact', normalize: true },
    decimals: { type: 'exact' },
    symbol: { type: 'exact', normalize: true },
    total_supply: { type: 'relative', threshold: 0.01 },
    balance: { type: 'relative', threshold: 0.01 },
};

/** A reference provider with per-network config already bound. */
interface ReferenceProvider {
    fetchMetadata(network: string, contract: string): Promise<MetadataResult>;
    fetchBalances(network: string, contract: string): Promise<BalancesResult>;
}

let runInProgress = false;
let currentRun: RunRecord | null = null;

export function isRunning(): boolean {
    return runInProgress;
}

/** Returns the in-progress run's current state, or null if idle. */
export function getProgress(): (RunRecord & { total_tokens: number }) | null {
    if (!currentRun) return null;
    return { ...currentRun, total_tokens: currentRunTotalTokens };
}

let currentRunTotalTokens = 0;

function loadTokens(): TokenReference[] {
    return require('../tokens.json') as TokenReference[];
}

function formatDateTime(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build metadata comparison records for one token against one reference provider. */
function buildMetadataRecords(
    token: TokenReference,
    ourResult: TokenApiResult,
    refResult: MetadataResult,
    runId: string,
    runAt: string
): ComparisonRecord[] {
    const records: ComparisonRecord[] = [];
    const metadataFields: (keyof TokenMetadata)[] = ['name', 'decimals', 'symbol', 'total_supply'];

    for (const field of metadataFields) {
        const tolerance = TOLERANCES[field];
        if (!tolerance) continue;
        const result = compareField(field, ourResult.data[field], refResult.data[field], tolerance);
        records.push({
            run_id: runId,
            run_at: runAt,
            domain: 'metadata',
            network: token.network,
            contract: token.contract,
            symbol: token.symbol,
            field: result.field,
            entity: '',
            our_value: result.our_value,
            reference_value: result.reference_value,
            provider: refResult.provider,
            relative_diff: result.relative_diff,
            is_match: result.is_match,
            tolerance: result.tolerance,
            our_fetched_at: formatDateTime(ourResult.fetched_at),
            reference_fetched_at: formatDateTime(refResult.fetched_at),
            our_block_timestamp: ourResult.block_timestamp ? formatDateTime(ourResult.block_timestamp) : null,
            our_url: ourResult.url,
            reference_url: refResult.url,
            our_null_reason: ourResult.null_reasons[field] ?? null,
            reference_null_reason: refResult.null_reasons[field] ?? null,
        });
    }

    return records;
}

/** Build balance comparison records for one token by joining balances by address. */
function buildBalanceRecords(
    token: TokenReference,
    ourBalances: BalancesResult,
    refBalances: BalancesResult,
    runId: string,
    runAt: string
): ComparisonRecord[] {
    const tolerance = TOLERANCES.balance as FieldTolerance;

    // If either side had a wholesale failure, record a single null row
    if (
        (ourBalances.null_reason && ourBalances.null_reason !== 'empty') ||
        (refBalances.null_reason && refBalances.null_reason !== 'empty')
    ) {
        return [
            {
                run_id: runId,
                run_at: runAt,
                domain: 'balance',
                network: token.network,
                contract: token.contract,
                symbol: token.symbol,
                field: 'balance',
                entity: '',
                our_value: null,
                reference_value: null,
                provider: refBalances.provider,
                relative_diff: null,
                is_match: false,
                tolerance: tolerance.threshold ?? 0,
                our_fetched_at: formatDateTime(ourBalances.fetched_at),
                reference_fetched_at: formatDateTime(refBalances.fetched_at),
                our_block_timestamp: ourBalances.block_timestamp ? formatDateTime(ourBalances.block_timestamp) : null,
                our_url: ourBalances.url,
                reference_url: refBalances.url,
                our_null_reason: ourBalances.null_reason,
                reference_null_reason: refBalances.null_reason,
            },
        ];
    }

    // Join by address and compare balances
    const ourMap = new Map<string, string>();
    for (const entry of ourBalances.balances) {
        ourMap.set(entry.address, entry.balance);
    }

    const refMap = new Map<string, string>();
    for (const entry of refBalances.balances) {
        refMap.set(entry.address, entry.balance);
    }

    const records: ComparisonRecord[] = [];
    for (const [address, ourBalance] of ourMap) {
        const refBalance = refMap.get(address);
        if (refBalance == null) continue;

        const result = compareField('balance', ourBalance, refBalance, tolerance);
        records.push({
            run_id: runId,
            run_at: runAt,
            domain: 'balance',
            network: token.network,
            contract: token.contract,
            symbol: token.symbol,
            field: 'balance',
            entity: address,
            our_value: result.our_value,
            reference_value: result.reference_value,
            provider: refBalances.provider,
            relative_diff: result.relative_diff,
            is_match: result.is_match,
            tolerance: result.tolerance,
            our_fetched_at: formatDateTime(ourBalances.fetched_at),
            reference_fetched_at: formatDateTime(refBalances.fetched_at),
            our_block_timestamp: ourBalances.block_timestamp ? formatDateTime(ourBalances.block_timestamp) : null,
            our_url: ourBalances.url,
            reference_url: refBalances.url,
            our_null_reason: null,
            reference_null_reason: null,
        });
    }

    return records;
}

/** Compare a pre-fetched Token API result against all reference providers (metadata + balances). */
async function validateToken(
    token: TokenReference,
    ourResult: TokenApiResult,
    references: ReferenceProvider[],
    tokenApi: TokenApiProvider,
    runId: string,
    runAt: string
): Promise<{ records: ComparisonRecord[]; error: boolean }> {
    try {
        const refMetadataResults = await Promise.allSettled(
            references.map((ref) => ref.fetchMetadata(token.network, token.contract))
        );

        const [ourBalancesSettled, ...refBalancesSettled] = await Promise.allSettled([
            tokenApi.fetchBalances(token.network, token.contract),
            ...references.map((ref) => ref.fetchBalances(token.network, token.contract)),
        ]);

        const allRecords: ComparisonRecord[] = [];

        // Metadata comparisons
        for (const settled of refMetadataResults) {
            if (settled.status === 'rejected') {
                logger.warn(
                    `Reference metadata fetch failed for ${token.symbol} on ${token.network}: ${settled.reason}`
                );
                continue;
            }
            allRecords.push(...buildMetadataRecords(token, ourResult, settled.value, runId, runAt));
        }

        // Balance comparisons
        if (ourBalancesSettled.status === 'rejected') {
            logger.warn(
                `Our balance fetch failed for ${token.symbol} on ${token.network}: ${ourBalancesSettled.reason}`
            );
        } else {
            const ourBalances = ourBalancesSettled.value;
            for (const settled of refBalancesSettled) {
                if (settled.status === 'rejected') {
                    logger.warn(
                        `Reference balance fetch failed for ${token.symbol} on ${token.network}: ${settled.reason}`
                    );
                    continue;
                }
                allRecords.push(...buildBalanceRecords(token, ourBalances, settled.value, runId, runAt));
            }
        }

        return { records: allRecords, error: false };
    } catch (error) {
        logger.error(`Failed to validate ${token.symbol} on ${token.network}:`, error);
        return { records: [], error: true };
    }
}

/** Validate all tokens on a single network: batch-fetch from Token API, then compare each against references. */
async function validateNetwork(
    tokens: TokenReference[],
    tokenApi: TokenApiProvider,
    references: ReferenceProvider[],
    runId: string,
    runAt: string
): Promise<{ records: ComparisonRecord[]; errors: number }> {
    const network = (tokens[0] as TokenReference).network;
    const contracts = tokens.map((t) => t.contract);
    await tokenApi.prefetchMetadata(network, contracts);

    const allRecords: ComparisonRecord[] = [];
    let errors = 0;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] as TokenReference;
        const ourResult = await tokenApi.fetchMetadata(token.network, token.contract);
        const result = await validateToken(token, ourResult, references, tokenApi, runId, runAt);
        allRecords.push(...result.records);
        if (result.error) errors++;

        if (currentRun) {
            currentRun.tokens_checked++;
            if (result.error) currentRun.errors++;
            const counts = tallyCounts(result.records);
            currentRun.comparisons += counts.comparisons;
            currentRun.matches += counts.matches;
            currentRun.mismatches += counts.mismatches;
            currentRun.nulls += counts.nulls;
        }

        if (i < tokens.length - 1) {
            await sleep(config.rateLimitMs);
        }
    }

    return { records: allRecords, errors };
}

/**
 * Run a full validation cycle: sync the registry, fetch metadata and balances
 * from Token API and reference providers for every token, compare results, and persist to ClickHouse.
 * Only one run may execute at a time.
 */
export async function runValidation(trigger: 'scheduled' | 'manual', runId = crypto.randomUUID()): Promise<RunRecord> {
    if (runInProgress) {
        throw new Error('Validation run already in progress');
    }

    runInProgress = true;
    const startedAt = new Date();
    const runAt = formatDateTime(startedAt);

    logger.info(`Starting validation run ${runId} (trigger=${trigger})`);

    try {
        await syncRegistry();

        const tokens = loadTokens();
        if (tokens.length === 0) {
            throw new Error('tokens.json is empty');
        }

        currentRunTotalTokens = tokens.length;
        currentRun = {
            run_id: runId,
            started_at: formatDateTime(startedAt),
            completed_at: null,
            trigger,
            tokens_checked: 0,
            comparisons: 0,
            matches: 0,
            mismatches: 0,
            nulls: 0,
            errors: 0,
            status: 'success',
            error_detail: null,
        };

        const byNetwork = new Map<string, TokenReference[]>();
        for (const token of tokens) {
            const group = byNetwork.get(token.network) ?? [];
            group.push(token);
            byNetwork.set(token.network, group);
        }

        const tokenApi = new TokenApiProvider();
        const blockscout = new BlockscoutProvider();
        const etherscan = new EtherscanProvider();

        const networks = [...byNetwork.entries()];
        const networkResults = await Promise.allSettled(
            networks.map(([network, networkTokens]) => {
                const choices = getAvailableProviders(network);
                if (choices.length === 0) {
                    logger.warn(`No reference provider available for network ${network}, skipping`);
                    return Promise.resolve({
                        records: [] as ComparisonRecord[],
                        errors: networkTokens.length,
                    });
                }
                const references: ReferenceProvider[] = choices.map((choice) =>
                    choice.kind === 'blockscout' ? blockscout : etherscan
                );
                return validateNetwork(networkTokens, tokenApi, references, runId, runAt);
            })
        );

        const allRecords: ComparisonRecord[] = [];
        let totalErrors = 0;
        let numTokensChecked = 0;

        for (const [i, result] of networkResults.entries()) {
            const [network, networkTokens] = networks[i] as [string, TokenReference[]];

            if (result.status === 'fulfilled') {
                allRecords.push(...result.value.records);
                totalErrors += result.value.errors;
                const checked = networkTokens.length - result.value.errors;
                tokensChecked.inc({ network }, checked);
                numTokensChecked += checked;
            } else {
                logger.error(`Network ${network} failed entirely:`, result.reason);
                totalErrors += networkTokens.length;
            }
        }

        const counts = tallyCounts(allRecords);

        const totalTokens = tokens.length;
        let status: 'success' | 'partial' | 'failed';
        if (totalErrors === 0) status = 'success';
        else if (totalErrors < totalTokens) status = 'partial';
        else status = 'failed';

        await insertComparisons(allRecords);

        const completedAt = new Date();
        const run: RunRecord = {
            run_id: runId,
            started_at: formatDateTime(startedAt),
            completed_at: formatDateTime(completedAt),
            trigger,
            tokens_checked: numTokensChecked,
            ...counts,
            errors: totalErrors,
            status,
            error_detail: totalErrors > 0 ? `${totalErrors} token(s) failed validation` : null,
        };

        await insertRun(run);

        const duration = (completedAt.getTime() - startedAt.getTime()) / 1000;
        runDuration.observe(duration);
        runsTotal.inc({ trigger, status });
        logger.info(
            `Run ${runId} completed in ${duration.toFixed(1)}s: ` +
                `${numTokensChecked} tokens, ${counts.matches} matches, ${counts.mismatches} mismatches, ` +
                `${counts.nulls} nulls, ${totalErrors} errors`
        );

        return run;
    } catch (error) {
        const completedAt = new Date();
        const run: RunRecord = {
            run_id: runId,
            started_at: formatDateTime(startedAt),
            completed_at: formatDateTime(completedAt),
            trigger,
            tokens_checked: 0,
            comparisons: 0,
            matches: 0,
            mismatches: 0,
            nulls: 0,
            errors: 1,
            status: 'failed',
            error_detail: error instanceof Error ? error.message : String(error),
        };

        try {
            await insertRun(run);
        } catch (chError) {
            logger.error('Failed to write failed run to ClickHouse:', chError);
        }

        runsTotal.inc({ trigger, status: 'failed' });
        logger.error(`Run ${runId} failed:`, error);
        return run;
    } finally {
        runInProgress = false;
        currentRun = null;
        currentRunTotalTokens = 0;
    }
}
