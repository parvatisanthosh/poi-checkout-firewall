-- CreateEnum
CREATE TYPE "ArenaStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'STOPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "AntibodyState" AS ENUM ('CANDIDATE', 'ACTIVE', 'RETIRED');

-- CreateTable
CREATE TABLE "ArenaRun" (
    "id" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "status" "ArenaStatus" NOT NULL DEFAULT 'QUEUED',
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArenaRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArenaGeneration" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "asrStatic" DOUBLE PRECISION NOT NULL,
    "asrImmune" DOUBLE PRECISION NOT NULL,
    "coverage" INTEGER NOT NULL,
    "bestFitness" DOUBLE PRECISION NOT NULL,
    "defenderVersion" INTEGER NOT NULL,

    CONSTRAINT "ArenaGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttackGenome" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "family" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "parentIds" TEXT[],
    "strategy" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "listing" JSONB NOT NULL,
    "split" TEXT NOT NULL,
    "attackerModel" TEXT NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttackGenome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArenaTrial" (
    "id" TEXT NOT NULL,
    "genomeId" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "fitness" DOUBLE PRECISION NOT NULL,
    "chosenPoison" BOOLEAN NOT NULL,
    "verdictStatic" TEXT,
    "verdictImmune" TEXT,
    "reported" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArenaTrial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArenaCell" (
    "runId" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "eliteGenomeId" TEXT,
    "eliteFitness" DOUBLE PRECISION,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ArenaCell_pkey" PRIMARY KEY ("runId","family","channel")
);

-- CreateTable
CREATE TABLE "StrategyEntry" (
    "id" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "channel" TEXT,
    "text" TEXT NOT NULL,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StrategyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Antibody" (
    "id" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "minhash" INTEGER[],
    "embedding" vector(1536),
    "features" JSONB NOT NULL,
    "skeleton" TEXT,
    "action" TEXT NOT NULL,
    "state" "AntibodyState" NOT NULL DEFAULT 'CANDIDATE',
    "hits" INTEGER NOT NULL DEFAULT 0,
    "falseHits" INTEGER NOT NULL DEFAULT 0,
    "defenderVersion" INTEGER NOT NULL,
    "retiredVersion" INTEGER,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Antibody_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AntibodyBand" (
    "band" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "antibodyId" TEXT NOT NULL,

    CONSTRAINT "AntibodyBand_pkey" PRIMARY KEY ("band","hash","antibodyId")
);

-- CreateTable
CREATE TABLE "MerchantRisk" (
    "merchantId" TEXT NOT NULL,
    "voids" INTEGER NOT NULL DEFAULT 0,
    "reports" INTEGER NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantRisk_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "Calibration" (
    "id" TEXT NOT NULL,
    "alpha" DOUBLE PRECISION NOT NULL,
    "result" JSONB NOT NULL,
    "defenderVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Calibration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefenderState" (
    "id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "activeCalibrationId" TEXT,

    CONSTRAINT "DefenderState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefenderVersionLog" (
    "version" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "calibrationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefenderVersionLog_pkey" PRIMARY KEY ("version")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArenaGeneration_runId_generation_key" ON "ArenaGeneration"("runId", "generation");

-- CreateIndex
CREATE INDEX "AttackGenome_runId_generation_idx" ON "AttackGenome"("runId", "generation");

-- CreateIndex
CREATE INDEX "ArenaTrial_genomeId_idx" ON "ArenaTrial"("genomeId");

-- CreateIndex
CREATE INDEX "Antibody_state_idx" ON "Antibody"("state");

-- CreateIndex
CREATE INDEX "AntibodyBand_band_hash_idx" ON "AntibodyBand"("band", "hash");

-- AddForeignKey
ALTER TABLE "ArenaGeneration" ADD CONSTRAINT "ArenaGeneration_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ArenaRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttackGenome" ADD CONSTRAINT "AttackGenome_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ArenaRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArenaTrial" ADD CONSTRAINT "ArenaTrial_genomeId_fkey" FOREIGN KEY ("genomeId") REFERENCES "AttackGenome"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArenaCell" ADD CONSTRAINT "ArenaCell_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ArenaRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AntibodyBand" ADD CONSTRAINT "AntibodyBand_antibodyId_fkey" FOREIGN KEY ("antibodyId") REFERENCES "Antibody"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Layer 2 defender starts at version 0 with no calibration (idempotent).
INSERT INTO "DefenderState" ("id", "version", "activeCalibrationId") VALUES (1, 0, NULL)
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "DefenderVersionLog" ("version", "reason", "calibrationId") VALUES (0, 'initial', NULL)
ON CONFLICT ("version") DO NOTHING;
