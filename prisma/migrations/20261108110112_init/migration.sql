-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "IntentStatus" AS ENUM ('SIGNED', 'REVOKED');

-- CreateEnum
CREATE TYPE "RunMode" AS ENUM ('LIVE', 'DRY_RUN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'ERROR');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('CAPTURE', 'ASK_HUMAN', 'VOID');

-- CreateEnum
CREATE TYPE "SettlementAction" AS ENUM ('CAPTURED', 'VOIDED', 'PENDING_HUMAN', 'NONE');

-- CreateTable
CREATE TABLE "Intent" (
    "id" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "specHash" TEXT NOT NULL,
    "jws" TEXT NOT NULL,
    "mandate" JSONB NOT NULL,
    "status" "IntentStatus" NOT NULL DEFAULT 'SIGNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Intent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRecord" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "mode" "RunMode" NOT NULL,
    "paypalStatus" TEXT NOT NULL,
    "authorizationId" TEXT,
    "captureId" TEXT,
    "rawOrder" JSONB,
    "normalized" JSONB,
    "agentTrace" JSONB NOT NULL,
    "runTag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'QUEUED',
    "verdict" "Verdict",
    "checks" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "latencyMs" INTEGER,
    "humanDecision" "Verdict",
    "settlement" "SettlementAction",
    "paypalStatus" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceRecord" (
    "seq" SERIAL NOT NULL,
    "verificationId" TEXT NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "jws" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TermsChunk" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" vector(1536),

    CONSTRAINT "TermsChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderRecord_runTag_idx" ON "OrderRecord"("runTag");

-- CreateIndex
CREATE INDEX "OrderRecord_intentId_idx" ON "OrderRecord"("intentId");

-- CreateIndex
CREATE INDEX "OrderRecord_createdAt_idx" ON "OrderRecord"("createdAt");

-- CreateIndex
CREATE INDEX "Verification_orderId_createdAt_idx" ON "Verification"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceRecord_verificationId_key" ON "EvidenceRecord"("verificationId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceRecord_hash_key" ON "EvidenceRecord"("hash");

-- CreateIndex
CREATE INDEX "TermsChunk_merchantId_idx" ON "TermsChunk"("merchantId");

-- AddForeignKey
ALTER TABLE "OrderRecord" ADD CONSTRAINT "OrderRecord_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "Intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "Verification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TermsChunk" ADD CONSTRAINT "TermsChunk_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
