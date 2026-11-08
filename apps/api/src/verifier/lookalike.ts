// Look-alike seller detection. "VoItra Official" (capital i) must not pass as "Voltra Official".

// Applied before lowercasing, so case-dependent look-alikes (I vs l) are caught.
const CASE_CONFUSABLES: Record<string, string> = { I: "l", "|": "l" };

// Cyrillic / Greek letters that render like Latin ones (lowercase after NFKC + toLowerCase).
const HOMOGLYPHS: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ӏ: "l",
  ɡ: "g",
  α: "a",
  β: "b",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
};

const DIGIT_CONFUSABLES: Record<string, string> = {
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
};

/** Plain comparable form: NFKC, lowercase, letters and digits only. */
export function basicName(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Visual skeleton: two names with the same skeleton look the same to a person.
 * NFKC -> case confusables -> lowercase -> homoglyphs -> digits -> rn/vv -> strip the rest.
 */
export function skeleton(s: string): string {
  let out = [...s.normalize("NFKC")]
    .map((ch) => CASE_CONFUSABLES[ch] ?? ch)
    .join("")
    .toLowerCase();
  out = [...out].map((ch) => HOMOGLYPHS[ch] ?? DIGIT_CONFUSABLES[ch] ?? ch).join("");
  out = out.replace(/rn/g, "m").replace(/vv/g, "w");
  return out.replace(/[^a-z0-9]/g, "");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Edit distance allowed for "looks like": 2 per the plan, but 1 for short names (fewer false hits). */
const threshold = (len: number) => (len < 8 ? 1 : 2);

export interface LookalikeMatch {
  verifiedId: string;
  verifiedName: string;
  distance: number;
}

/**
 * The verified merchant that `displayName` imitates, if any. `claimedId` is the merchant id the
 * order claims (from custom_id). A merchant is genuine when it claims a verified id AND shows
 * that merchant's name exactly (or a truncation of it, since soft descriptors are cut to 22
 * chars). Anything else that looks like a verified name is an imitation -- including an order
 * that claims a verified id but shows the name with homoglyphs.
 */
export function findLookalike(
  displayName: string,
  claimedId: string,
  verified: Array<{ id: string; displayName: string }>,
): LookalikeMatch | undefined {
  const shownBasic = basicName(displayName);
  const shownSkel = skeleton(displayName);
  if (shownSkel.length < 3) return undefined; // nothing Latin-looking to compare
  let best: LookalikeMatch | undefined;
  for (const v of verified) {
    const vBasic = basicName(v.displayName);
    if (
      v.id === claimedId &&
      (shownBasic === vBasic || (shownBasic.length >= 8 && vBasic.startsWith(shownBasic)))
    ) {
      return undefined; // genuine
    }
    const vSkel = skeleton(v.displayName);
    const distance = levenshtein(shownSkel, vSkel);
    if (distance <= threshold(vSkel.length) && (!best || distance < best.distance)) {
      best = { verifiedId: v.id, verifiedName: v.displayName, distance };
    }
  }
  return best;
}
