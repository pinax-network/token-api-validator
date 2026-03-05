import { compare, isNullComparison } from './comparator.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { runDuration, runsTotal, tokensChecked } from './metrics.js';
import { BlockscoutProvider } from './providers/blockscout.js';
import { EtherscanProvider } from './providers/etherscan.js';
import { TokenApiProvider, type TokenApiResult } from './providers/token-api.js';
import type { ProviderResult, TokenReference } from './providers/types.js';
import { getAvailableProviders, syncRegistry } from './registry.js';
import { type ComparisonRecord, insertComparisons, insertRun, type RunRecord } from './storage/clickhouse.js';

/** A reference provider with per-network config already bound. */
interface ReferenceProvider {
    fetch(network: string, contract: string): Promise<ProviderResult>;
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

interface TokenResult {
    comparisons: ComparisonRecord[];
    error: boolean;
}

/** Fetch metadata from Token API once and compare against all reference providers. */
async function validateToken(
    token: TokenReference,
    tokenApi: TokenApiProvider,
    references: ReferenceProvider[],
    runId: string,
    runAt: string
): Promise<TokenResult> {
    try {
        const ourResult = await tokenApi.fetch(token.network, token.contract);

        const refResults = await Promise.allSettled(references.map((ref) => ref.fetch(token.network, token.contract)));

        const allComparisons: ComparisonRecord[] = [];
        for (const settled of refResults) {
            if (settled.status === 'rejected') {
                logger.warn(`Reference fetch failed for ${token.symbol} on ${token.network}: ${settled.reason}`);
                continue;
            }
            const refResult = settled.value;
            const results = compare(ourResult.data, refResult.data);
            for (const r of results) {
                allComparisons.push({
                    run_id: runId,
                    run_at: runAt,
                    network: token.network,
                    contract: token.contract,
                    symbol: token.symbol,
                    field: r.field,
                    our_value: r.our_value,
                    reference_value: r.reference_value,
                    provider: refResult.provider,
                    relative_diff: r.relative_diff,
                    is_match: r.is_match,
                    tolerance: r.tolerance,
                    our_fetched_at: formatDateTime(ourResult.fetched_at),
                    reference_fetched_at: formatDateTime(refResult.fetched_at),
                    our_block_timestamp: (ourResult as TokenApiResult).block_timestamp
                        ? formatDateTime((ourResult as TokenApiResult).block_timestamp as Date)
                        : null,
                    our_url: ourResult.url,
                    reference_url: refResult.url,
                    our_null_reason: ourResult.null_reason,
                    reference_null_reason: refResult.null_reason,
                });
            }
        }

        return { comparisons: allComparisons, error: false };
    } catch (error) {
        logger.error(`Failed to validate ${token.symbol} on ${token.network}:`, error);
        return { comparisons: [], error: true };
    }
}

/** Validate all tokens on a single network sequentially, rate-limiting between each. */
async function validateNetwork(
    tokens: TokenReference[],
    tokenApi: TokenApiProvider,
    references: ReferenceProvider[],
    runId: string,
    runAt: string
): Promise<{ comparisons: ComparisonRecord[]; errors: number }> {
    const allComparisons: ComparisonRecord[] = [];
    let errors = 0;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] as TokenReference;
        const result = await validateToken(token, tokenApi, references, runId, runAt);
        allComparisons.push(...result.comparisons);
        if (result.error) errors++;

        if (currentRun) {
            currentRun.tokens_checked++;
            if (result.error) currentRun.errors++;
            for (const c of result.comparisons) {
                currentRun.comparisons++;
                if (isNullComparison(c)) currentRun.nulls++;
                else if (c.is_match) currentRun.matches++;
                else currentRun.mismatches++;
            }
        }

        // Rate limit between tokens (not after the last one)
        if (i < tokens.length - 1) {
            await sleep(config.rateLimitMs);
        }
    }

    return { comparisons: allComparisons, errors };
}

/**
 * Run a full validation cycle: sync the registry, fetch metadata from Token API and
 * reference providers for every token, compare results, and persist to ClickHouse.
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
                    return Promise.resolve({ comparisons: [] as ComparisonRecord[], errors: networkTokens.length });
                }
                const references: ReferenceProvider[] = choices.map((choice) =>
                    choice.kind === 'blockscout'
                        ? { fetch: (n, c) => blockscout.fetch(n, c, choice.url) }
                        : { fetch: (n, c) => etherscan.fetch(n, c, choice.chain_id) }
                );
                return validateNetwork(networkTokens, tokenApi, references, runId, runAt);
            })
        );

        const allComparisons: ComparisonRecord[] = [];
        let totalErrors = 0;
        let numTokensChecked = 0;

        for (const [i, result] of networkResults.entries()) {
            const [network, networkTokens] = networks[i] as [string, TokenReference[]];

            if (result.status === 'fulfilled') {
                allComparisons.push(...result.value.comparisons);
                totalErrors += result.value.errors;
                const checked = networkTokens.length - result.value.errors;
                tokensChecked.inc({ network }, checked);
                numTokensChecked += checked;
            } else {
                logger.error(`Network ${network} failed entirely:`, result.reason);
                totalErrors += networkTokens.length;
            }
        }

        let matches = 0;
        let mismatches = 0;
        let nulls = 0;
        for (const c of allComparisons) {
            if (isNullComparison(c)) {
                nulls++;
            } else if (c.is_match) {
                matches++;
            } else {
                mismatches++;
            }
        }

        const totalTokens = tokens.length;
        let status: 'success' | 'partial' | 'failed';
        if (totalErrors === 0) status = 'success';
        else if (totalErrors < totalTokens) status = 'partial';
        else status = 'failed';

        await insertComparisons(allComparisons);

        const completedAt = new Date();
        const run: RunRecord = {
            run_id: runId,
            started_at: formatDateTime(startedAt),
            completed_at: formatDateTime(completedAt),
            trigger,
            tokens_checked: numTokensChecked,
            comparisons: allComparisons.length,
            matches,
            mismatches,
            nulls,
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
                `${numTokensChecked} tokens, ${matches} matches, ${mismatches} mismatches, ${totalErrors} errors`
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
    }
}
