-- AlterTable
ALTER TABLE "Antibody" ADD COLUMN     "shingleCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Verification" ADD COLUMN     "l2" JSONB;

-- CreateTable
CREATE TABLE "AntibodyHit" (
    "id" TEXT NOT NULL,
    "antibodyId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "live" BOOLEAN NOT NULL,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "falseHit" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AntibodyHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AntibodyHit_antibodyId_createdAt_idx" ON "AntibodyHit"("antibodyId", "createdAt");

-- CreateIndex
CREATE INDEX "AntibodyHit_verificationId_idx" ON "AntibodyHit"("verificationId");

-- CreateIndex
CREATE INDEX "Antibody_sourceOrderId_idx" ON "Antibody"("sourceOrderId");

-- AddForeignKey
ALTER TABLE "AntibodyHit" ADD CONSTRAINT "AntibodyHit_antibodyId_fkey" FOREIGN KEY ("antibodyId") REFERENCES "Antibody"("id") ON DELETE CASCADE ON UPDATE CASCADE;
