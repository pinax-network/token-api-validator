import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
    port: z.coerce.number().default(3000),
    clickhouseUrl: z.string().url(),
    clickhouseUsername: z.string(),
    clickhousePassword: z.string(),
    clickhouseDatabase: z.string().default('validation'),
    tokenApiBaseUrl: z.string().url(),
    tokenApiJwt: z.string().min(1),
    etherscanApiKey: z.string().optional(),
    pinaxRpcApiKey: z.string().optional(),
    solscanApiKey: z.string().optional(),
    drpcApiKey: z.string().optional(),
    cronSchedule: z.string().default('0 */6 * * *'),
    rateLimitMs: z.coerce.number().default(500),
    retryMaxAttempts: z.coerce.number().default(3),
    retryBaseDelayMs: z.coerce.number().default(1000),
    rpcBatchSize: z.coerce.number().default(25),
    verbose: z.preprocess((val) => String(val).toLowerCase() === 'true', z.boolean()).default(false),
    prettyLogging: z.preprocess((val) => String(val).toLowerCase() === 'true', z.boolean()).default(false),
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse({
    port: process.env.PORT,
    clickhouseUrl: process.env.CLICKHOUSE_URL,
    clickhouseUsername: process.env.CLICKHOUSE_USERNAME,
    clickhousePassword: process.env.CLICKHOUSE_PASSWORD,
    clickhouseDatabase: process.env.CLICKHOUSE_DATABASE,
    tokenApiBaseUrl: process.env.TOKEN_API_BASE_URL,
    tokenApiJwt: process.env.TOKEN_API_JWT,
    etherscanApiKey: process.env.ETHERSCAN_API_KEY,
    pinaxRpcApiKey: process.env.PINAX_RPC_API_KEY,
    solscanApiKey: process.env.SOLSCAN_API_KEY,
    drpcApiKey: process.env.DRPC_API_KEY,
    cronSchedule: process.env.CRON_SCHEDULE,
    rateLimitMs: process.env.RATE_LIMIT_MS,
    retryMaxAttempts: process.env.RETRY_MAX_ATTEMPTS,
    retryBaseDelayMs: process.env.RETRY_BASE_DELAY_MS,
    rpcBatchSize: process.env.RPC_BATCH_SIZE,
    verbose: process.env.VERBOSE,
    prettyLogging: process.env.PRETTY_LOGGING,
});
