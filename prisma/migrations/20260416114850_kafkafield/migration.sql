/*
  Warnings:

  - You are about to drop the column `kafka_published_at` on the `gateway_payments` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "gateway_payments" DROP COLUMN "kafka_published_at",
ADD COLUMN     "kafkaPublishedAt" TIMESTAMPTZ,
ADD COLUMN     "tradingAccountId" UUID;
