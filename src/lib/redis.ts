import Redis from 'ioredis';
import { config } from '../config/env';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Redis NAT Map
//
// Problem: Redis Cluster nodes advertise their *internal* IPs (10.50.0.x) in
// CLUSTER NODES gossip. When ioredis receives this gossip it tries to connect
// to those internal IPs directly — which fails from outside the k8s network.
//
// Solution: Use ioredis `natMap` to rewrite internal host:port → external VPN
// host:port before making any connection attempt.
//
// Mapping (verified via `redis-cli CLUSTER NODES` on each VPN port):
//   10.50.0.184:6379  →  185.131.54.146:31010  (master, slots 0-5460)
//   10.50.0.186:6379  →  185.131.54.146:31011  (master, slots 5461-10922)
//   10.50.0.188:6379  →  185.131.54.146:31003  (master, slots 10923-16383)
//   10.50.0.190:6379  →  185.131.54.146:31009  (slave of 10.50.0.188)
//   10.50.0.192:6379  →  185.131.54.146:31007  (slave of 10.50.0.186)
//   10.50.0.194:6379  →  185.131.54.146:31008  (slave of 10.50.0.184)
//
// For local dev (127.0.0.1): natMap is empty — no rewriting needed.
// ─────────────────────────────────────────────────────────────────────────────

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

    if (hasNatMap) {
        logger.info({ entries: Object.keys(natMap).length }, 'Redis Cluster natMap active');
    }

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

    cluster.on('error',   (err: Error) => logger.error({ err }, 'Redis Cluster error'));
    cluster.on('connect', ()           => logger.debug('Redis Cluster connecting'));
    cluster.on('+node',   (node)       => logger.debug({ node: `${node.options.host}:${node.options.port}` }, 'Redis Cluster node added'));
    
    return cluster;
}

let redisClient: RedisClient;

export function getRedis(): RedisClient {
    if (!redisClient) redisClient = createClient();
    return redisClient;
}

/**
 * The `redis` export is a Proxy that delegates to the actual ioredis client.
 * This keeps compatibility with callers that use `redis.get()`, `redis.setex()`, etc.
 */
export const redis: RedisClient = new Proxy({} as RedisClient, {
    get(_target, prop: string | symbol) {
        const client = getRedis();
        
        // Return original methods if they are called on this proxy
        const val = (client as any)[prop];
        if (typeof val === 'function') {
            return val.bind(client);
        }
        return val;
    }
});

export async function connectRedis(): Promise<void> {
    const client = getRedis(); // This triggers creation via Proxy
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
