import { clipTextEmbedding, clipImageEmbedding, cosine } from "./clip.js";
import { toDirectDropbox } from "./merge.js";
import type { ImageInsight } from "./image-insight.js";

const MIN_ASSIGN_DEFAULT = 0.18;
const MAX_IMAGES_PER_GROUP = 12;
const BLACKLIST_TOKENS = ["dummy", "placeholder", "sample", "template"];

const tokenize = (value: string): string[] =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

type Candidate = {
  url: string;
  name?: string;
  folder?: string;
  order: number;
  index: number;
};

type DebugLog = {
  groupId: string;
  prompt: string;
  top: Array<{ url: string; score: number }>;
};

type VisionSortArgs = {
  groups: any[];
  candidates: Candidate[];
  insightMap: Map<string, ImageInsight>;
  originalImageSets: Array<Set<string>>;
  minScore?: number;
  debug?: boolean;
};

type VisionSortResult = {
  groups: any[];
  orphans: Candidate[];
  debugLogs: DebugLog[];
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }

  const workers = new Array(Math.min(limit, items.length)).fill(0).map(() => worker());
  await Promise.all(workers);
  return results;
}

function buildPrompt(group: any): string {
  const parts: string[] = [];
  if (typeof group?.brand === "string" && group.brand.trim()) parts.push(group.brand.trim());
  if (typeof group?.product === "string" && group.product.trim()) parts.push(group.product.trim());
  if (typeof group?.variant === "string" && group.variant.trim()) parts.push(group.variant.trim());
  if (Array.isArray(group?.claims)) {
    for (const claim of group.claims) {
      if (typeof claim === "string" && claim.trim()) parts.push(claim.trim());
    }
  }
  if (parts.length === 0) return "product photo";
  return parts.join(", ");
}

function applyHeuristics(
  candidate: Candidate,
  groupIndex: number,
  originalImageSets: Array<Set<string>>,
  insightMap: Map<string, ImageInsight>,
  groupKeywords: Array<Set<string>>
): number {
  let score = 0;
  const cleanUrl = toDirectDropbox(candidate.url);

  if (originalImageSets[groupIndex]?.has(cleanUrl)) score += 0.35;

  const insight = insightMap.get(cleanUrl);
  if (insight) {
    if (insight.role === "front") score += 0.05;
    else if (insight.role === "side") score += 0.02;
    else if (insight.role === "back") score -= 0.04;
    if (insight.hasVisibleText) score += 0.02;
    if (insight.dominantColor && /^(black|white)$/.test(insight.dominantColor)) score -= 0.05;
  }

  const text = `${candidate.name || ""} ${candidate.folder || ""}`.toLowerCase();
  if (text) {
    let matches = 0;
    for (const token of groupKeywords[groupIndex]) {
      if (token && text.includes(token)) matches++;
    }
    if (matches) score += Math.min(matches, 3) * 0.02;
  }

  if (candidate.name) {
    const lower = candidate.name.toLowerCase();
    if (BLACKLIST_TOKENS.some((bad) => lower.includes(bad))) score -= 0.08;
  }

  return score;
}

export async function applyVisionSortV2(args: VisionSortArgs): Promise<VisionSortResult> {
  const { groups, candidates, insightMap, originalImageSets, minScore, debug } = args;
  if (!Array.isArray(groups) || !groups.length || !Array.isArray(candidates) || !candidates.length) {
    return { groups, orphans: [], debugLogs: [] };
  }

  const prompts = groups.map((group) => buildPrompt(group));
  const groupKeywords = prompts.map((prompt) => new Set(tokenize(prompt)));

  const textEmbeddings = await Promise.all(
    prompts.map(async (prompt) => {
      try {
        return await clipTextEmbedding(prompt);
      } catch (err) {
        console.warn("[vision-sort] text embedding failed", err);
        return null;
      }
    })
  );

  const clipAvailable = textEmbeddings.some((emb) => Array.isArray(emb) && emb.length > 0);
  const imageEmbeddings = await (clipAvailable
    ? mapLimit(candidates, 3, (candidate) => clipImageEmbedding(candidate.url).catch(() => null))
    : Promise.resolve(candidates.map(() => null)));

  const threshold = typeof minScore === "number" && Number.isFinite(minScore) ? minScore : MIN_ASSIGN_DEFAULT;

  const assignments: Candidate[][] = groups.map(() => []);
  const pairScoresByGroup: Array<Array<{ candidateIndex: number; score: number }>> = groups.map(() => []);
  const pairScoresByCandidate: Array<Array<{ groupIndex: number; score: number }>> = candidates.map(() => []);

  const orphans: Candidate[] = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    const candidate = candidates[ci];
    const imageEmbedding = imageEmbeddings[ci];
    let bestGroup = -1;
    let bestScore = -Infinity;

    for (let gi = 0; gi < groups.length; gi++) {
      const textEmbedding = textEmbeddings[gi];
      let score = 0;
      if (clipAvailable && imageEmbedding && textEmbedding && imageEmbedding.length === textEmbedding.length) {
        const similarity = cosine(imageEmbedding, textEmbedding);
        if (Number.isFinite(similarity)) score += similarity;
      }
      score += applyHeuristics(candidate, gi, originalImageSets, insightMap, groupKeywords);

      pairScoresByGroup[gi].push({ candidateIndex: ci, score });
      pairScoresByCandidate[ci].push({ groupIndex: gi, score });

      if (score > bestScore) {
        bestScore = score;
        bestGroup = gi;
      }
    }

    if (bestGroup >= 0 && bestScore >= threshold) {
      assignments[bestGroup].push(candidate);
    } else {
      orphans.push(candidate);
    }
  }

  if (orphans.length) {
    const remaining: Candidate[] = [];
    for (const orphan of orphans) {
      let fallbackGroup = -1;
      let fallbackScore = -Infinity;
      const candidateScores = pairScoresByCandidate[orphan.index] || [];
      for (const entry of candidateScores) {
        if (assignments[entry.groupIndex].length > 0) continue;
        if (entry.score > fallbackScore) {
          fallbackScore = entry.score;
          fallbackGroup = entry.groupIndex;
        }
      }
      if (fallbackGroup >= 0) {
        assignments[fallbackGroup].push(orphan);
      } else {
        remaining.push(orphan);
      }
    }
    orphans.length = 0;
    orphans.push(...remaining);
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const sorted = assignments[gi]
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((item) => toDirectDropbox(item.url))
      .filter(Boolean)
      .slice(0, MAX_IMAGES_PER_GROUP);
    groups[gi].images = sorted;
  }

  const debugLogs: DebugLog[] = [];
  if (debug) {
    for (let gi = 0; gi < groups.length; gi++) {
      const rawTop = pairScoresByGroup[gi]
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(({ candidateIndex, score }) => ({ url: candidates[candidateIndex]?.url, score }));
      debugLogs.push({
        groupId: String(groups[gi]?.groupId || `group_${gi + 1}`),
        prompt: prompts[gi],
        top: rawTop
          .filter((entry) => entry.url)
          .map((entry) => ({ url: entry.url!, score: Number(entry.score.toFixed(4)) })),
      });
    }
  }

  return {
    groups,
    orphans,
    debugLogs,
  };
}
