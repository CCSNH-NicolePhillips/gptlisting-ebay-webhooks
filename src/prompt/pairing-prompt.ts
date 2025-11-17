// Copilot: Create and export two functions for Prompt 2 (pairing):
//   getPairingSystemPrompt(): string
//   getPairingUserPrompt(): string
// Use EXACT text below (verbatim) for both prompts.

export function getPairingSystemPrompt() {
  return `You are a front↔back product image matcher. Pair images into the same product when one is a FRONT and the other is a BACK. Use only the JSON provided from the prior vision step; do not re-interpret images or fetch external knowledge. Be deterministic and follow the scoring and acceptance rules exactly.`;
}

export function getPairingUserPrompt() {
  return `
TASK:
Given:
- groups[]: brand, product, variant, size, category, categoryPath, images[0], primaryImageUrl (same as images[0])
- imageInsights[]: { url, hasVisibleText, dominantColor, role, roleScore, evidenceTriggers[], textExtracted, visualDescription }

Do NOT modify any field. Only pair FRONT images to BACK images. Ignore SIDE/OTHER unless no back exists and you need to leave items unpaired.

Scoring (compute matchScore for every front vs back; include details):

VISUAL SIMILARITY (highest priority - your 2-year-old can do this):
• +3 if packagingType matches exactly (from visualDescription: pouch, dropper-bottle, bottle, jar, tube, canister, box)
• +2.5 if dominantColor matches exactly (same color name)
• +2 if dominantColor is close/similar (e.g., "light-blue" vs "blue", "dark-red" vs "red")
• +1.5 if packaging is compatible but not identical (bottle vs dropper-bottle)

TEXT SIMILARITY (secondary - only when visual is ambiguous):
• +3 × productNameSimilarity (0..1) using token overlap of product (lowercased, split on non-alphanumerics)
• +2 × variantSimilarity (0..1) from variant
• +2 × sizeMatch (1 if canonical sizes equal; allow fl oz↔ml, oz↔g)
• +categoryCompat from categoryPath (tree similarity):
  - identical leaf: +1.5
  - same branch (deep LCA): +1.0
  - related: +0.6
  - loose: +0.2
  - weak: −0.4
  - unrelated top-level: −1.2
• +1 × sharedOCR (0..1) overlap of 5+ char tokens between textExtracted
• +2 if back has barcode/LOT/EXP/QR and productNameSimilarity ≥ 0.5

Penalties:
• −3 if brands disagree (when both known). If one side brand is Unknown or empty, penalty −0.5 instead (visual similarity can compensate).
• −2 if packagingType obviously mismatches (pouch vs bottle), unless dominantColor matches exactly
• Role guardrail: if not FRONT vs BACK (e.g., role="other"), reduce penalty to −0.5 if visual similarity is strong (packaging + color match)

Unit normalization for sizeMatch:
• Convert fl oz → ml by ×29.573 and round ml
• Convert oz → g by ×28.35 and round g
• Hair/Cosmetics/Supplements/Food likely use ml/g; otherwise compare raw text

Acceptance rule (choose at most one back for each front):
• Accept best back if matchScore ≥ 2.0 and (best − runnerUp) ≥ 0.8
• Soft accept if same brand AND productNameSimilarity ≥ 0.85 AND categoryCompat ≥ 0.6, with matchScore ≥ 1.6
• Otherwise leave the front unpaired

Output STRICT JSON only:
{
  "pairs": [
    {
      "frontUrl": "<url>",
      "backUrl": "<url>",
      "matchScore": 0.00,
      "brand": "<normalized brand you used for comparison>",
      "product": "<normalized product you used>",
      "variant": "<normalized variant or null>",
      "sizeFront": "<canonicalized or original>",
      "sizeBack": "<canonicalized or original>",
      "evidence": [
        "productNameSimilarity: 0.92",
        "variantSimilarity: 1.00 (LEMON LIME)",
        "sizeMatch: 1 (720g vs 720g)",
        "categoryCompat: +1.50 (identical leaf)",
        "sharedOCR: 0.41",
        "barcode/lot on back",
        "packagingMatch: pouch",
        "colorClose: forest-green vs dark-forest-green"
      ],
      "confidence": 0.00
    }
  ],
  "singletons": [
    { "url": "<front-or-back-url>", "reason": "no candidate ≥ 2.0" }
  ],
  "debugSummary": []
}

Confidence ∈ [0..1] = min(1, matchScore / 3.5), and if any brand-mismatch penalty applied then max 0.6.

Constraints:
• Use imageInsights.url as the canonical URL everywhere.
• Do not invent text; only use provided fields.
• Do not change roles; treat roles as final.
• If two backs are within 0.5 of the best score, do NOT pick one; leave the front as singleton.
• Keep pairs unique (a back may belong to only one front).
• Be deterministic: ties → leave unpaired.

CANDIDATE HINTS (hard requirements):
• You will receive a second JSON object named HINTS after the INPUT JSON.
• HINTS has:
  {
    "featuresByUrl": { "<url>": { brandNorm, productTokens, variantTokens, sizeCanonical, packagingHint, categoryTail, colorKey, role }},
    "candidatesByFront": { "<frontUrl>": ["<backUrl>", ...] }
  }
• For each FRONT image, you MUST choose at most one BACK from candidatesByFront[frontUrl].
• If candidatesByFront[frontUrl] exists and is NON-EMPTY, you MUST NOT output this front in singletons with "no candidates". If you decline to pair, your singleton reason MUST start with: "declined despite candidates", and include the top 3 candidate scores.
• If candidatesByFront[frontUrl] does not exist OR is EMPTY, then "no candidates" is valid.

STRICT CHECK:
• It is an error to output a pair where backUrl is not in candidatesByFront[frontUrl].
• It is an error to output "no candidates" when candidatesByFront[frontUrl] is non-empty.
• If any error condition is encountered, instead of pairing, output a singleton for that front with reason "contract violation: <explain>".

TIE-BREAK & SCORE ECHO (mandatory):
• For each front with allowedBacks, compute your own matchScore for each candidate and output the top-3 scores in "debugSummary" as lines:
  "front=<url> candidate=<backUrl> matchScore=<x.xx>"
• If the best candidate's matchScore ≥ 2.0 and exceeds the runner-up by ≥ 0.8, you MUST pair it.
• If brand is the same AND productNameSimilarity ≥ 0.85 AND categoryCompat ≥ 0.6 AND matchScore ≥ 1.6, you SHOULD pair it (soft accept).
• If you decline to pair despite candidates, the singleton reason MUST start with: "declined despite candidates", and include the top-3 scores.
`.trim();
}
