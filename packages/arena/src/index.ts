/**
 * @poi/arena - Attacker engine for Layer 2 (CONTRACTS-L2 section 4.6).
 *
 * All signatures match CONTRACTS-L2 4.6 / ArenaEngine exactly.
 */
import type { ArenaEngine } from "@poi/shared";
import { listingText } from "./canonical";
import { scoreFitness, shouldReplaceElite } from "./fitness";
import { noveltyCos } from "./novelty";
import { crossover, explore, fromStrategy, mutate } from "./operators";
import { oracle } from "./oracle";
import { proposeGeneration } from "./propose";
import { buildGenerationZeroSeeds, seeds } from "./seeds";
import { summarizeStrategies } from "./strategies";
import { validateListing } from "./validate";

export {
  listingText,
  validateListing,
  noveltyCos,
  scoreFitness,
  shouldReplaceElite,
  oracle,
  summarizeStrategies,
  proposeGeneration,
  seeds,
  buildGenerationZeroSeeds,
  mutate,
  crossover,
  fromStrategy,
  explore,
};

export const arenaEngine: ArenaEngine = {
  proposeGeneration,
  validateListing,
  noveltyCos,
  scoreFitness,
  shouldReplaceElite,
  oracle,
  summarizeStrategies,
  listingText,
};

export default arenaEngine;
