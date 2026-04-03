-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('stripe', 'pay2pay', 'tylt_crypto');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('deposit', 'withdrawal');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED', 'DUPLICATE');

-- CreateTable
CREATE TABLE "gateway_payments" (
    "id" UUID NOT NULL,
    "merchantReferenceId" VARCHAR(64) NOT NULL,
    "gateway" "PaymentGateway" NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL DEFAULT 'deposit',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "userId" UUID NOT NULL,
    "userType" VARCHAR(20) NOT NULL,
    "initiatorUserId" UUID,
    "initiatorUserType" VARCHAR(20),
    "requestedAmount" DECIMAL(18,6) NOT NULL,
    "requestedCurrency" VARCHAR(10) NOT NULL,
    "paidAmount" DECIMAL(18,6),
    "paidCurrency" VARCHAR(10),
    "settledAmount" DECIMAL(18,6),
    "settledCurrency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "creditedAmount" DECIMAL(18,6),
    "feeAmount" DECIMAL(18,6),
    "feeCurrency" VARCHAR(10),
    "fxRate" DECIMAL(18,8),
    "providerReferenceId" VARCHAR(128),
    "idempotencyKey" VARCHAR(128),
    "linkedUserTxnId" UUID,
    "providerPayload" JSONB,
    "metadata" JSONB,
    "expiresAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "gateway_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_payment_events" (
    "id" UUID NOT NULL,
    "paymentId" UUID,
    "gateway" "PaymentGateway" NOT NULL,
    "providerEventId" VARCHAR(128),
    "eventType" VARCHAR(64) NOT NULL,
    "payloadHash" VARCHAR(64),
    "merchantReferenceId" VARCHAR(64),
    "processingStatus" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMPTZ,
    "processingError" TEXT,
    "payload" JSONB NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_configs" (
    "gateway" "PaymentGateway" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "displayName" VARCHAR(80) NOT NULL,
    "supportedCurrencies" TEXT[],
    "minAmountUsd" DECIMAL(18,6),
    "maxAmountUsd" DECIMAL(18,6),
    "config" JSONB,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "gateway_configs_pkey" PRIMARY KEY ("gateway")
);

-- CreateTable
CREATE TABLE "fx_rate_overrides" (
    "id" UUID NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "setByAdminId" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "fx_rate_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gateway_payments_merchantReferenceId_key" ON "gateway_payments"("merchantReferenceId");

-- CreateIndex
CREATE INDEX "gateway_payments_userId_status_createdAt_idx" ON "gateway_payments"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "gateway_payments_gateway_status_idx" ON "gateway_payments"("gateway", "status");

-- CreateIndex
CREATE INDEX "gateway_payments_status_createdAt_idx" ON "gateway_payments"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_payments_gateway_providerReferenceId_key" ON "gateway_payments"("gateway", "providerReferenceId");

-- CreateIndex
CREATE INDEX "gateway_payment_events_paymentId_idx" ON "gateway_payment_events"("paymentId");

-- CreateIndex
CREATE INDEX "gateway_payment_events_processingStatus_createdAt_idx" ON "gateway_payment_events"("processingStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_payment_events_gateway_providerEventId_key" ON "gateway_payment_events"("gateway", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_payment_events_gateway_payloadHash_key" ON "gateway_payment_events"("gateway", "payloadHash");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rate_overrides_pair_key" ON "fx_rate_overrides"("pair");

-- AddForeignKey
ALTER TABLE "gateway_payment_events" ADD CONSTRAINT "gateway_payment_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "gateway_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
