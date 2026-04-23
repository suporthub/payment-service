import pino from 'pino';
import { config } from '../config/env';
import path from 'path';
import fs from 'fs';

// Ensure log directory exists at startup
const logDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// ── Transport targets ────────────────────────────────────────────────────────
const targets: pino.TransportTargetOptions[] = [];

if (config.NODE_ENV !== 'production') {
  // Dev: pretty-print to stdout
  targets.push({
    target:  'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    level:   'debug',
  });
} else {
  // Production: plain JSON to stdout (Docker/systemd captures this)
  targets.push({
    target:  'pino/file',
    options: { destination: 1 },
    level:   'info',
  });
}

// File transport — enabled in dev + prod. Switch to pino-loki / pino-datadog
// later by adding a new target here. Zero change to business logic.
if (config.LOG_TO_FILE) {
  targets.push({
    target:  'pino-roll',
    options: {
      file:      path.join(logDir, `${config.SERVICE_NAME}.log`),
      frequency: 'daily',
      limit:     { count: 30 },
      size:      '100m',          // roll early if a single file exceeds 100 MB
    },
    level: 'debug',
  });
}

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    base:  { service: config.SERVICE_NAME },
  },
  pino.transport({ targets }),
);
