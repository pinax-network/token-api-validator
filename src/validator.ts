import { compareField, type FieldTolerance } from './comparator.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { runDuration, runsTotal, tokensChecked } from './metrics.js';
import { BlockscoutProvider } from './providers/blockscout.js';
import { EtherscanProvider } from './providers/etherscan.js';
import { RpcProvider } from './providers/rpc.js';
import { SolanaRpcProvider } from './providers/solana-rpc.js';
import { SolscanProvider } from './providers/solscan.js';
import { TokenApiProvider } from './providers/token-api.js';
import type { Provider, ProviderResult, TokenReference } from './providers/types.js';
import { syncRegistry } from './registry.js';
import { insertComparisons, insertRun } from './storage/clickhouse.js';
import { type ComparisonRecord, type RunRecord, tallyCounts } from './storage/types.js';

const TOLERANCES: Record<string, FieldTolerance> = {
    name: { type: 'exact', normalize: true },
    decimals: { type: 'exact' },
    symbol: { type: 'exact', normalize: true },
    total_supply: { type: 'relative', threshold: 0.01 },
    balance: { type: 'relative', threshold: 0.01 },
};

type ProviderFetch = (provider: Provider) => Promise<ProviderResult>;

type RunProgress = RunRecord & { total_tokens: number };

let runInProgress = false;
let currentRun: RunProgress | null = null;

export function isRunning(): boolean {
    return runInProgress;
}

export function getProgress(): RunProgress | null {
    return currentRun;
}

function formatDateTime(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

/** Join two ProviderResults by (field, entity) and produce ComparisonRecords. */
function buildComparisonRecords(
    token: TokenReference,
    ours: ProviderResult,
    ref: ProviderResult,
    runId: string,
    runAt: string
): ComparisonRecord[] {
    const refByKey = new Map<string, (typeof ref.entries)[number]>();
    for (const entry of ref.entries) {
        refByKey.set(`${entry.field}:${entry.entity}`, entry);
    }

    const records: ComparisonRecord[] = [];
    for (const ourEntry of ours.entries) {
        const key = `${ourEntry.field}:${ourEntry.entity}`;
        const refEntry = refByKey.get(key);
        if (!refEntry) continue;

        const tolerance = TOLERANCES[ourEntry.field];
        if (!tolerance) continue;

        const result = compareField(ourEntry.field, ourEntry.value, refEntry.value, tolerance);
        records.push({
            run_id: runId,
            run_at: runAt,
            domain: ours.domain,
            network: token.network,
            contract: token.contract,
            symbol: token.symbol,
            field: result.field,
            entity: ourEntry.entity,
            our_value: result.our_value,
            reference_value: result.reference_value,
            provider: ref.provider,
            relative_diff: result.relative_diff,
            is_match: result.is_match,
            tolerance: result.tolerance,
            our_fetched_at: formatDateTime(ours.fetched_at),
            reference_fetched_at: formatDateTime(ref.fetched_at),
            our_block_timestamp: ours.block_timestamp ? formatDateTime(ours.block_timestamp) : null,
            our_url: ours.url,
            reference_url: ref.url,
            our_null_reason: ourEntry.null_reason,
            reference_null_reason: refEntry.null_reason,
        });
    }
    return records;
}

/** Fetch and compare one token against all reference providers across all domains. */
async function validateToken(
    token: TokenReference,
    tokenApi: TokenApiProvider,
    references: Provider[],
    runId: string,
    runAt: string
): Promise<{ records: ComparisonRecord[]; error: boolean }> {
    const { network, contract } = token;
    // Populated after each Token API fetch; RPC closures read these via late binding
    let holders: string[] = [];
    let blockNumber: number | null = null;
    let holderBlocks: Map<string, number> = new Map();
    const domains: ProviderFetch[] = [
        (p) => p.fetchMetadata(network, contract, blockNumber),
        (p) => p.fetchBalances(network, contract, holders, holderBlocks),
    ];

    try {
        const allRecords: ComparisonRecord[] = [];

        for (const fetchDomain of domains) {
            let ours: ProviderResult;
            try {
                ours = await fetchDomain(tokenApi);
            } catch (error) {
                logger.warn(`Our fetch failed for ${token.symbol} on ${network}: ${error}`);
                continue;
            }

            holders = ours.entries.filter((e) => e.entity).map((e) => e.entity);
            blockNumber = ours.block_number ?? null;
            holderBlocks = new Map<string, number>();
            for (const e of ours.entries) {
                if (e.entity && e.block_number != null) holderBlocks.set(e.entity, e.block_number);
            }
            const refs = await Promise.allSettled(references.map((ref) => fetchDomain(ref)));

            for (const ref of refs) {
                if (ref.status === 'rejected') {
                    logger.warn(`Reference fetch failed for ${token.symbol} on ${network}: ${ref.reason}`);
                    continue;
                }
                allRecords.push(...buildComparisonRecords(token, ours, ref.value, runId, runAt));
            }
        }

        return { records: allRecords, error: false };
    } catch (error) {
        logger.error(`Failed to validate ${token.symbol} on ${token.network}:`, error);
        return { records: [], error: true };
    }
}

async function validateNetwork(
    tokens: TokenReference[],
    tokenApi: TokenApiProvider,
    references: Provider[],
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
        const result = await validateToken(token, tokenApi, references, runId, runAt);
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
            await new Promise((resolve) => setTimeout(resolve, config.rateLimitMs));
        }
    }

    return { records: allRecords, errors };
}

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

        const tokens = require('../tokens.json') as TokenReference[];
        if (tokens.length === 0) {
            throw new Error('tokens.json is empty');
        }

        currentRun = {
            run_id: runId,
            started_at: formatDateTime(startedAt),
            completed_at: null,
            trigger,
            tokens_checked: 0,
            total_tokens: tokens.length,
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
        const allProviders: Provider[] = [
            new BlockscoutProvider(),
            new EtherscanProvider(),
            new SolscanProvider(),
            new RpcProvider(),
            new SolanaRpcProvider(),
        ];

        const allRecords: ComparisonRecord[] = [];
        let totalErrors = 0;
        let numTokensChecked = 0;

        for (const [network, networkTokens] of byNetwork) {
            const references = allProviders.filter((p) => p.supportsNetwork(network));
            if (references.length === 0) {
                logger.warn(`No reference provider available for network ${network}, skipping`);
                totalErrors += networkTokens.length;
                continue;
            }

            try {
                const result = await validateNetwork(networkTokens, tokenApi, references, runId, runAt);
                allRecords.push(...result.records);
                totalErrors += result.errors;
                const checked = networkTokens.length - result.errors;
                tokensChecked.inc({ network }, checked);
                numTokensChecked += checked;
            } catch (error) {
                logger.error(`Network ${network} failed entirely:`, error);
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
    }
}
