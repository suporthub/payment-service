import Redis from 'ioredis';
import { config } from '../config/env';
import { logger } from './logger';

export type RedisClient = Redis | InstanceType<typeof Redis.Cluster>;

function buildNatMap(): Record<string, { host: string; port: number }> {
    if (config.REDIS_NAT_MAP) {
        try {
            return JSON.parse(config.REDIS_NAT_MAP);
        } catch {
            logger.warn('REDIS_NAT_MAP is set but could not be parsed as JSON — ignoring');
        }
    }
    return {};
}

function isSingleNodeMode(): boolean {
    return (
        config.REDIS_CLUSTER_NODES.length === 1 &&
        (config.REDIS_CLUSTER_NODES[0]!.host === '127.0.0.1' ||
            config.REDIS_CLUSTER_NODES[0]!.host === 'localhost')
    );
}

function createClient(): RedisClient {
    if (isSingleNodeMode()) {
        const node = config.REDIS_CLUSTER_NODES[0]!;
        const client = new Redis({ host: node.host, port: node.port, lazyConnect: true });
        client.on('error', (err: Error) => logger.error({ err }, 'Redis error'));
        return client;
    }

    const natMap = buildNatMap();
    const hasNatMap = Object.keys(natMap).length > 0;

    const cluster = new Redis.Cluster(config.REDIS_CLUSTER_NODES, {
        ...(hasNatMap && { natMap }),
        slotsRefreshTimeout: 5_000,
        redisOptions: {
            connectTimeout: 6_000,
            commandTimeout: 5_000,
            enableReadyCheck: true,
            maxRetriesPerRequest: 3,
        },
        clusterRetryStrategy: (times: number) => {
            if (times > 10) return null;
            return Math.min(200 * times, 3_000);
        },
    });

    cluster.on('error', (err: Error) => logger.error({ err }, 'Redis Cluster error'));
    return cluster;
}

let redisClient: RedisClient;

/**
 * The `redis` export is a Proxy that delegates to the actual ioredis client.
 * This keeps compatibility with callers that use `redis.get()`, `redis.setex()`, etc.
 */
export const redis: RedisClient = new Proxy({} as RedisClient, {
    get(_target, prop: string | symbol) {
        if (!redisClient) redisClient = createClient();
        
        // Return original methods if they are called on this proxy
        const val = (redisClient as any)[prop];
        if (typeof val === 'function') {
            return val.bind(redisClient);
        }
        return val;
    }
});

export async function connectRedis(): Promise<void> {
    const client = redis; // This triggers creation via Proxy
    if (isSingleNodeMode()) {
        await (client as Redis).connect();
    } else {
        await new Promise<void>((resolve, reject) => {
            const cluster = client as InstanceType<typeof Redis.Cluster>;
            if (cluster.status === 'ready') { resolve(); return; }

            const timer = setTimeout(() => reject(new Error('Redis Cluster ready timeout (15 s)')), 15_000);
            cluster.once('ready', () => { clearTimeout(timer); resolve(); });
            cluster.once('error', (err: Error) => { clearTimeout(timer); reject(err); });
        });
    }
    logger.info({ mode: isSingleNodeMode() ? 'single-node' : 'cluster' }, 'Redis connected');
}

export async function disconnectRedis(): Promise<void> {
    if (redisClient) await redisClient.quit();
}
