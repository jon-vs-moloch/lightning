/**
 * Router v0 — picks the relevant branch tips to fan a question out to.
 *
 * Per branch we keep a short summary (Vane when installed, extractive
 * fallback otherwise) and score candidate tips with lexical BM25 plus a
 * recency bonus. Deterministic and cheap; no other dependencies.
 */
import type { MessageRecord } from "./types.js";

/** Result of fitting a tree with Vane. */
export interface VaneFitResult {
  text: string;
  metrics?: { mode?: string; coverage?: number; outputTokens?: number; sourceTokens?: number };
}

/** Minimal structural type of the optional `@owl-kestrel/vane` module. */
export interface VaneModule {
  fitTree(tree: unknown, options: unknown): VaneFitResult;
}

/** A per-branch summary plus provenance about how it was produced. */
export interface BranchSummary {
  text: string;
  method: "vane" | "extractive";
  budgetTokens: number;
  sourceChars: number;
  detail?: Record<string, unknown>;
}

const vaneCache = new Map<string, Promise<VaneModule | undefined>>();

/** Load the optional Vane module (dynamic import of a variable, so tsc never resolves it). Cached per specifier. */
export async function loadVane(specifier = "@owl-kestrel/vane"): Promise<VaneModule | undefined> {
  if (process.env.LIGHTNING_VANE === "off") return undefined;
  let cached = vaneCache.get(specifier);
  if (!cached) {
    cached = (async () => {
      try {
        const mod: any = await import(/* vane is optional and not a repo dependency */ specifier);
        if (typeof mod?.fitTree === "function") return mod as VaneModule;
        if (typeof mod?.default?.fitTree === "function") return mod.default as VaneModule;
        return undefined;
      } catch {
        return undefined;
      }
    })();
    vaneCache.set(specifier, cached);
  }
  return cached;
}

/** Collapse whitespace and return the first sentence (cut at ". ", "? ", "! " or a newline), hard-capped at maxChars. */
export function firstSentence(text: string, maxChars = 160): string {
  // Single-pass collapse of whitespace, remembering where the first newline lands.
  let collapsed = "";
  let firstNewline = -1;
  let pendingSpace = false;
  for (const ch of text) {
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      if (ch === "\n" && firstNewline === -1 && collapsed.length > 0) firstNewline = collapsed.length;
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && collapsed.length > 0) collapsed += " ";
    collapsed += ch;
    pendingSpace = false;
  }
  // Earliest punctuation boundary (cut keeps the punctuation).
  let punctuationCut = -1;
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i];
    if ((ch === "." || ch === "?" || ch === "!") && (i + 1 === collapsed.length || collapsed[i + 1] === " ")) {
      punctuationCut = i + 1;
      break;
    }
  }
  const candidates = [punctuationCut, firstNewline].filter((n) => n > 0 && n <= maxChars);
  if (candidates.length > 0) return collapsed.slice(0, Math.min(...candidates)).trimEnd();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, maxChars) + "…";
}

/** Rough token estimate: ~4 characters per token. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SUMMARY_SNIPPET_CHARS = 120;

/**
 * Represent a branch as a Vane tree: one node per non-empty message (title =
 * first sentence, summary = first 400 chars, detail = full text), equally
 * ranked so Vane's coverage-first fit shows as many turns as the budget allows.
 * Measured on the managed-tree eval set: per-node ids cost budget, and a
 * recency salience hid mid-branch facts (router hit@1 16/24 vs 19/24 without).
 */
export function branchToVaneTree(title: string, messages: MessageRecord[]): Record<string, unknown> {
  const children: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (!message.content.trim()) continue;
    children.push({
      title: `${message.role}: ${firstSentence(message.content, SUMMARY_SNIPPET_CHARS)}`,
      summary: message.content.replace(/\s+/g, " ").trim().slice(0, 400),
      detail: message.content,
    });
  }
  return { title, children };
}

/**
 * Sentence-level Vane tree for compaction: one node per turn whose title is
 * its first sentence and whose children are its remaining sentences, so Vane
 * can keep individual sentences instead of all-or-nothing turn bodies.
 * Measured on the managed-tree eval set (12 branches, one planted fact each as
 * the second sentence of a middle turn): at a budget of 0.75x the source this
 * tree kept 12/12 facts where the turn-level tree kept 0/12; at 0.5x both kept
 * 0/12. Small synthetic set, chosen after seeing those numbers.
 */
export function branchToSentenceTree(title: string, messages: MessageRecord[]): Record<string, unknown> {
  const children: Record<string, unknown>[] = [];
  for (const message of messages) {
    const sentences = message.content.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length === 0) continue;
    children.push({
      title: `${message.role}: ${sentences[0]}`,
      children: sentences.slice(1).map((sentence) => ({ title: sentence })),
    });
  }
  return { title, children };
}

/** Budget-aware bullet-list summary used when Vane is unavailable. */
export function extractiveSummary(title: string, messages: MessageRecord[], budgetTokens: number): string {
  const first = `- ${title}`;
  const lines: string[] = [first];
  let joinedChars = first.length; // tracks the exact joined text, separators included
  const candidates: string[] = [];
  for (const message of messages) {
    if (!message.content.trim()) continue;
    candidates.push(`  - ${message.role}: ${firstSentence(message.content, SUMMARY_SNIPPET_CHARS)}`);
  }
  // Keep room for the "+ N more" tail whenever lines would be left out, so a
  // partial summary always says that it is partial.
  const tailChars = (left: number) => (left > 0 ? `\n  + ${left} more`.length : 0);
  const fits = (chars: number) => Math.ceil(chars / 4) <= budgetTokens;
  let shown = 0;
  for (let i = 0; i < candidates.length; i++) {
    const lineChars = 1 + candidates[i].length; // "\n" separator plus the line itself
    if (!fits(joinedChars + lineChars + tailChars(candidates.length - i - 1))) break;
    lines.push(candidates[i]);
    joinedChars += lineChars;
    shown = i + 1;
  }
  if (shown < candidates.length && fits(joinedChars + tailChars(candidates.length - shown))) {
    lines.push(`  + ${candidates.length - shown} more`);
  }
  return lines.join("\n");
}

/** Summarize one branch with Vane when available, else extractively; `method` records which path ran. */
export async function summarizeBranch(
  title: string,
  messages: MessageRecord[],
  options: { budgetTokens?: number; vane?: VaneModule | null; tree?: "messages" | "sentences" } = {},
): Promise<BranchSummary> {
  const budgetTokens = options.budgetTokens ?? 160;
  const sourceChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const vane = options.vane === null ? undefined : (options.vane ?? (await loadVane()));
  if (vane) {
    try {
      const tree =
        options.tree === "sentences" ? branchToSentenceTree(title, messages) : branchToVaneTree(title, messages);
      const fit = vane.fitTree(tree, { budget: { tokens: budgetTokens }, order: "source" });
      return {
        text: fit.text,
        method: "vane",
        budgetTokens,
        sourceChars,
        detail: {
          mode: fit.metrics?.mode,
          coverage: fit.metrics?.coverage,
          outputTokens: fit.metrics?.outputTokens,
          tree: options.tree ?? "messages",
        },
      };
    } catch (error) {
      return {
        text: extractiveSummary(title, messages, budgetTokens),
        method: "extractive",
        budgetTokens,
        sourceChars,
        detail: { vaneError: error instanceof Error ? error.message : String(error) },
      };
    }
  }
  return { text: extractiveSummary(title, messages, budgetTokens), method: "extractive", budgetTokens, sourceChars };
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "it",
  "this", "that", "with", "as", "at", "by", "from", "what", "which", "who", "how", "when", "where",
  "did", "do", "does", "we", "you", "i", "our", "my", "your", "me", "about", "can", "should", "would",
  "will", "there", "their", "they", "he", "she", "his", "her", "its", "not", "no", "yes", "so", "if",
  "then", "than", "but", "have", "has", "had",
]);

/** Lowercase lexical tokens: split on non-alphanumerics, drop stopwords/tiny tokens, naive singularization. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    tokens.push(raw.length > 3 && !raw.endsWith("ss") ? raw.replace(/s$/, "") : raw);
  }
  return tokens;
}

/** Standard Okapi BM25 over simple string documents. */
export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly termFrequencies = new Map<string, Map<string, number>>();
  private readonly docLengths = new Map<string, number>();

  constructor(k1 = 1.2, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  /** Index one document; re-adding an id replaces its previous contents. */
  add(id: string, text: string): void {
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    this.termFrequencies.set(id, counts);
    this.docLengths.set(id, counts.size > 0 ? [...counts.values()].reduce((a, b) => a + b, 0) : 0);
  }

  /** Score all documents for a query; only ids with score > 0 appear in the result. */
  score(query: string): Map<string, number> {
    const scores = new Map<string, number>();
    const queryTerms = new Set(tokenize(query));
    if (queryTerms.size === 0 || this.termFrequencies.size === 0) return scores;
    const totalDocs = this.termFrequencies.size;
    const avgLength = [...this.docLengths.values()].reduce((a, b) => a + b, 0) / totalDocs;
    for (const term of queryTerms) {
      let df = 0;
      for (const counts of this.termFrequencies.values()) if (counts.has(term)) df++;
      if (df === 0) continue;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      for (const [id, counts] of this.termFrequencies) {
        const tf = counts.get(term);
        if (!tf) continue;
        const docLength = this.docLengths.get(id) ?? 0;
        const denominator = tf + this.k1 * (1 - this.b + (this.b * docLength) / (avgLength || 1));
        scores.set(id, (scores.get(id) ?? 0) + idf * ((tf * (this.k1 + 1)) / denominator));
      }
    }
    for (const [id, score] of scores) if (score <= 0) scores.delete(id);
    return scores;
  }
}

/** One branch tip offered for routing. */
export interface RouterDoc { branchId: string; checkpointId: string; text: string; updatedAt: number }

/** Routing result for one doc. */
export interface RouteScore { branchId: string; checkpointId: string; score: number; lexical: number; recency: number }

/** Routing knobs. */
export interface RouteOptions { k: number; recencyWeight?: number; halfLifeMs?: number; now?: number }

/**
 * Score branch tips for a query: normalized BM25 lexical similarity plus a
 * recency bonus (exponential half-life decay). When nothing matches lexically,
 * ranking falls back to recency so a fan-out still reaches the most recent
 * tips; callers can inspect `lexical` (0 for every doc) to see that.
 */
export function routeQuery(query: string, docs: RouterDoc[], options: RouteOptions): RouteScore[] {
  const recencyWeight = options.recencyWeight ?? 0.15;
  const halfLifeMs = options.halfLifeMs ?? 86_400_000;
  const now = options.now ?? Date.now();
  const index = new Bm25Index();
  for (const doc of docs) index.add(doc.branchId, doc.text);
  const raw = index.score(query);
  let maxRaw = 0;
  for (const value of raw.values()) if (value > maxRaw) maxRaw = value;
  const scored: (RouteScore & { updatedAt: number })[] = docs.map((doc) => {
    const lexical = maxRaw > 0 ? (raw.get(doc.branchId) ?? 0) / maxRaw : 0;
    const recency = Math.pow(0.5, Math.max(0, now - doc.updatedAt) / halfLifeMs);
    return {
      branchId: doc.branchId,
      checkpointId: doc.checkpointId,
      score: lexical + recencyWeight * recency,
      lexical,
      recency,
      updatedAt: doc.updatedAt,
    };
  });
  scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || (a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0));
  return scored
    .slice(0, Math.max(0, Math.floor(options.k)))
    .map((entry) => ({
      branchId: entry.branchId,
      checkpointId: entry.checkpointId,
      score: entry.score,
      lexical: entry.lexical,
      recency: entry.recency,
    }));
}
