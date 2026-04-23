import type { Producer} from 'kafkajs';
import { Kafka, logLevel, Partitioners } from 'kafkajs';
import { config } from '../config/env';
import { logger } from './logger';

const kafka = new Kafka({
  clientId: config.KAFKA_CLIENT_ID,
  brokers:  config.KAFKA_BROKERS.split(','),
  logLevel: logLevel.WARN,
});

let producer: Producer | null = null;

export async function connectKafka(): Promise<void> {
  producer = kafka.producer({
    allowAutoTopicCreation: true,
    createPartitioner: Partitioners.LegacyPartitioner
  });
  await producer.connect();
  logger.info('Kafka producer connected');
}

export async function disconnectKafka(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    producer = null;
  }
}

/**
 * Publish a single event to a Kafka topic.
 * Key is the userId — ensures all events for a user land on the same partition.
 */
export async function publishEvent(
  topic: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!producer) {
    logger.warn({ topic }, 'Kafka producer not ready — skipping event');
    return;
  }
  await producer.send({
    topic,
    messages: [{ key, value: JSON.stringify(payload) }],
  });
}
