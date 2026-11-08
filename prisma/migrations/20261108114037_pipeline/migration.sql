-- DropIndex
DROP INDEX "EvidenceRecord_verificationId_key";

-- AlterTable
ALTER TABLE "Verification" ADD COLUMN     "mode" "RunMode" NOT NULL DEFAULT 'LIVE';

-- CreateTable
CREATE TABLE "ProcessedWebhookEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvidenceRecord_verificationId_idx" ON "EvidenceRecord"("verificationId");
