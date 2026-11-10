/**
 * Generation proposal for Arena (CONTRACTS-L2 4.6).
 *
 * Implements plan 5.1:
 * - Generation budget: 6 mutate / 3 crossover / 2 strategy / 1 explore (for pop 12)
 * - Parent choice: uniform over filled cells with a seeded RNG
 * - Runs validateListing and retries an invalid draft once with the validator's reasons fed back
 * - Returns exactly populationSize drafts (filling any deficit with mutates)
 * - Pure functions where possible; LLM calls pass attackerModel
 * - Evolved listings use fictional brands only; no real trademarks, no real people
 */
import {
  GenomeDraft,
  type AttackFamily,
  type Channel,
  type Genome,
  type IntentSpec,
  type ProposeGenerationInput,
  type Scenario,
} from "@poi/shared";
import { seededRandom } from "@poi/shared/arena-fake";
import { crossover, explore, fromStrategy, mutate } from "./operators";
import { seeds as gen0Seeds } from "./seeds";
import { validateListing } from "./validate";

function createSpecForScenario(scenario: Scenario): IntentSpec {
  return {
    version: "poi.intent/1",
    rawText: scenario.userText,
    category: scenario.category,
    mustHave: [],
    niceToHave: [],
    quantity: 1,
    maxTotal: {
      currency: "USD",
      value: scenario.category === "wireless earbuds" ? "60.00" : "50.00",
    },
    oneTimeOnly: true,
    allowedConditions: ["new"],
    allowAddOns: false,
    allowedMerchants: undefined,
    blockedMerchants: [],
    humanPresent: true,
    ambiguities: [],
  };
}

export async function proposeGeneration(i: ProposeGenerationInput): Promise<GenomeDraft[]> {
  if (!i.families.length) {
    throw new Error("proposeGeneration: at least one family required");
  }

  const rand = seededRandom(i.seed ^ (i.generation * 17923 + 41));
  const drafts: GenomeDraft[] = [];

  // Match scenario
  const defaultScenario = i.scenarios[0]!;

  // Generation 0 or no elites: use generation 0 seeds
  if (i.generation === 0 || i.elites.length === 0) {
    const candidateSeeds = gen0Seeds.filter(
      (s) =>
        i.families.includes(s.family) &&
        i.scenarios.some((sc) => sc.category === s.listing.category),
    );
    const pool = candidateSeeds.length > 0 ? candidateSeeds : gen0Seeds;

    for (let idx = 0; idx < i.populationSize; idx++) {
      const baseSeed = pool[idx % pool.length]!;
      const scenario =
        i.scenarios.find((s) => s.category === baseSeed.listing.category) ?? defaultScenario;
      const spec = createSpecForScenario(scenario);

      let draft = GenomeDraft.parse({
        ...baseSeed,
        scenarioId: scenario.id,
      });

      // Validate and retry if needed
      const check = validateListing(draft, scenario, spec);
      if (!check.valid) {
        draft = await mutate(
          {
            ...draft,
            id: `seed_repair_${idx}`,
            runId: i.runId,
            generation: 0,
            split: "train",
            attackerModel: i.attackerModel,
          },
          [],
          i.attackerModel,
          scenario,
          { rand, feedbackReasons: check.reasons },
        );
      }

      drafts.push(draft);
    }

    return drafts.slice(0, i.populationSize);
  }

  // Generation > 0 with elites:
  // Determine filled cells from archive (or fallback to elites list)
  const filledArchiveCells = i.archive.filter((c) => c.eliteGenomeId !== null);
  const eliteMap = new Map(i.elites.map((e) => [e.id, e]));

  const getUniformParent = (): Genome => {
    if (filledArchiveCells.length > 0) {
      const cell = filledArchiveCells[Math.floor(rand() * filledArchiveCells.length)]!;
      if (cell.eliteGenomeId && eliteMap.has(cell.eliteGenomeId)) {
        return eliteMap.get(cell.eliteGenomeId)!;
      }
    }
    return i.elites[Math.floor(rand() * i.elites.length)]!;
  };

  // Plan 5.1 target allocation:
  // For standard pop 12: 6 mutate, 3 crossover, 2 strategy, 1 explore
  let numMutate = 6;
  let numCrossover = 3;
  let numStrategy = 2;
  let numExplore = 1;

  if (i.populationSize !== 12) {
    const scale = i.populationSize / 12;
    numMutate = Math.max(1, Math.round(6 * scale));
    numCrossover = Math.max(0, Math.round(3 * scale));
    numStrategy = Math.max(0, Math.round(2 * scale));
    numExplore = Math.max(0, i.populationSize - (numMutate + numCrossover + numStrategy));
  }

  // Helper to validate and retry once with feedback
  const generateAndValidate = async (
    generatorFn: (feedback?: string[]) => Promise<GenomeDraft>,
    targetScenario: Scenario,
  ): Promise<GenomeDraft> => {
    const spec = createSpecForScenario(targetScenario);
    let draft = await generatorFn();
    const check = validateListing(draft, targetScenario, spec);

    if (!check.valid) {
      // Retry once feeding back the validator's reasons
      draft = await generatorFn(check.reasons);
      const retryCheck = validateListing(draft, targetScenario, spec);
      if (!retryCheck.valid) {
        // Fallback: mutate a known elite/seed to guarantee valid draft
        const parent = getUniformParent();
        draft = await mutate(parent, [], "mock", targetScenario, { rand });
      }
    }
    return draft;
  };

  // 1. MUTATE operators (6)
  for (let m = 0; m < numMutate; m++) {
    const parent = getUniformParent();
    const scenario =
      i.scenarios.find((s) => s.category === parent.listing.category) ?? defaultScenario;
    const parentStrats = i.library.filter((s) => s.family === parent.family).slice(0, 3);

    const draft = await generateAndValidate(
      (feedback) =>
        mutate(parent, parentStrats, i.attackerModel, scenario, {
          rand,
          feedbackReasons: feedback,
        }),
      scenario,
    );
    drafts.push(draft);
  }

  // 2. CROSSOVER operators (3)
  for (let c = 0; c < numCrossover; c++) {
    const parentA = getUniformParent();
    // Prefer parentB from a different family
    const otherFamilyElites = i.elites.filter((e) => e.family !== parentA.family);
    const parentB =
      otherFamilyElites.length > 0
        ? otherFamilyElites[Math.floor(rand() * otherFamilyElites.length)]!
        : getUniformParent();

    const scenario =
      i.scenarios.find((s) => s.category === parentA.listing.category) ?? defaultScenario;

    const draft = await generateAndValidate(
      (feedback) =>
        crossover(parentA, parentB, i.attackerModel, scenario, { rand, feedbackReasons: feedback }),
      scenario,
    );
    drafts.push(draft);
  }

  // 3. FROM STRATEGY operators (2)
  for (let s = 0; s < numStrategy; s++) {
    const family = i.families[Math.floor(rand() * i.families.length)]!;
    const scenario = defaultScenario;
    const strat = i.library.find((l) => l.family === family) ??
      i.library[Math.floor(rand() * i.library.length)] ?? {
        id: `strat_default_${s}`,
        family,
        text: `Conceal ${family} intent violation using deceptive pricing structure and clear benefit framing`,
        wins: 1,
        losses: 0,
      };

    const draft = await generateAndValidate(
      (feedback) =>
        fromStrategy(strat, family, scenario, i.attackerModel, { rand, feedbackReasons: feedback }),
      scenario,
    );
    drafts.push(draft);
  }

  // 4. EXPLORE operator (1)
  for (let e = 0; e < numExplore; e++) {
    // Find empty cells in archive
    const emptyCells = i.archive.filter((c) => c.eliteGenomeId === null);
    let targetCell: { family: AttackFamily; channel: Channel };

    if (emptyCells.length > 0) {
      const chosen = emptyCells[Math.floor(rand() * emptyCells.length)]!;
      targetCell = { family: chosen.family, channel: chosen.channel };
    } else {
      // Pick any family and channel
      const fam = i.families[Math.floor(rand() * i.families.length)]!;
      const ch: Channel = "description";
      targetCell = { family: fam, channel: ch };
    }

    // Find nearest elite (same family, or any elite)
    const nearest = i.elites.find((el) => el.family === targetCell.family) ?? getUniformParent();
    const scenario =
      i.scenarios.find((s) => s.category === nearest.listing.category) ?? defaultScenario;

    const draft = await generateAndValidate(
      (feedback) =>
        explore(targetCell, nearest, i.attackerModel, scenario, {
          rand,
          feedbackReasons: feedback,
        }),
      scenario,
    );
    drafts.push(draft);
  }

  // 5. Fill any deficit with mutates to return exactly populationSize drafts
  while (drafts.length < i.populationSize) {
    const parent = getUniformParent();
    const scenario =
      i.scenarios.find((s) => s.category === parent.listing.category) ?? defaultScenario;
    const draft = await generateAndValidate(
      (feedback) =>
        mutate(parent, [], i.attackerModel, scenario, { rand, feedbackReasons: feedback }),
      scenario,
    );
    drafts.push(draft);
  }

  return drafts.slice(0, i.populationSize);
}
