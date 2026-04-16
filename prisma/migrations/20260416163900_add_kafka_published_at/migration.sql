ALTER TABLE gateway_payments ADD COLUMN IF NOT EXISTS kafka_published_at TIMESTAMPTZ;
