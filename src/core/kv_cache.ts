import { createHash } from "node:crypto";

/**
 * Bookkeeping for llama.cpp KV "slot files" saved by Lightning.
 *
 * Slot files are a DERIVED CACHE: the canonical transcript text is always kept
 * and always re-sent, so deleting a slot file only costs a re-prefill. This
 * module is the pure, filesystem-free ledger that decides what to keep and
 * what to evict; the caller performs the actual disk operations.
 */

export type KvTier = "hot" | "warm" | "cold";

export interface KvFileEntry {
  name: string; // slot file name (no directory)
  bytes: number; // n_written reported by llama-server save
  tokens: number; // n_saved reported by llama-server save
  createdAt: number; // ms epoch
  lastUsedAt: number; // ms epoch; bumped by touch()
  holders: Set<string>; // e.g. "branch:<id>", "ckpt:<id>"
}

export interface KvEvictionCandidate {
  name: string;
  bytes: number;
  rank: number;
}

export interface KvDiskLimitInput {
  /** Operator-set ceiling for Lightning's own slot files, in bytes (optional). */
  budgetBytes?: number;
  /** Bytes currently available to unprivileged users on the slot directory's filesystem (statfs bavail*bsize), if known. */
  fsAvailableBytes?: number;
  /** Bytes of slot files Lightning currently owns. */
  ownBytes: number;
  /** Free space that must remain on the filesystem after our files (see kvReserveBytes). */
  reserveBytes: number;
}

export interface KvDiskLimit {
  /** Max bytes our files may occupy; Infinity when neither a budget nor fs info is known. */
  limitBytes: number;
  /** Which input bound it: "budget", "filesystem", or "none". */
  boundBy: "budget" | "filesystem" | "none";
}

/**
 * Space needed for every slot to save a FULL context at the measured
 * bytes/token, so an in-flight save can never be the write that exhausts the
 * disk. Derived from measurements, not an arbitrary cap: slots * nCtxPerSlot *
 * bytesPerToken, rounded up. Returns 0 when the per-slot inputs are not
 * finite positive numbers.
 */
export function kvReserveBytes(input: {
  slots: number;
  nCtxPerSlot?: number;
  bytesPerToken?: number;
}): number {
  const { slots, nCtxPerSlot, bytesPerToken } = input;
  if (nCtxPerSlot === undefined || bytesPerToken === undefined || slots <= 0) return 0;
  for (const n of [slots, nCtxPerSlot, bytesPerToken]) {
    if (!Number.isFinite(n) || n <= 0) return 0;
  }
  return Math.ceil(slots * nCtxPerSlot * bytesPerToken);
}

/**
 * Effective byte limit for Lightning's own slot files. Our own files count as
 * reclaimable space on the filesystem bound (evicting them frees it); an
 * operator budget is an absolute ceiling. Reports which input was binding.
 */
export function computeKvDiskLimit(input: KvDiskLimitInput): KvDiskLimit {
  const fsLimit =
    input.fsAvailableBytes === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.ownBytes + input.fsAvailableBytes - input.reserveBytes);
  const budget =
    input.budgetBytes === undefined ? Number.POSITIVE_INFINITY : Math.max(0, input.budgetBytes);

  const limitBytes = Math.min(fsLimit, budget);
  let boundBy: KvDiskLimit["boundBy"];
  if (fsLimit === Number.POSITIVE_INFINITY && budget === Number.POSITIVE_INFINITY) {
    boundBy = "none";
  } else if (budget <= fsLimit) {
    boundBy = "budget";
  } else {
    boundBy = "filesystem";
  }
  return { limitBytes, boundBy };
}

/**
 * In-memory ledger of KV slot files. Never touches the filesystem: `release`
 * and `drop` return names for the caller to delete from disk, while
 * `add`/`hold`/`touch` reflect observed saves and usage.
 */
export class KvFileLedger {
  private readonly files = new Map<string, KvFileEntry>();

  /** Insert (or replace) an entry with empty holders, createdAt = lastUsedAt = now. */
  add(name: string, bytes: number, tokens: number, now = Date.now()): KvFileEntry {
    const entry: KvFileEntry = { name, bytes, tokens, createdAt: now, lastUsedAt: now, holders: new Set() };
    this.files.set(name, entry);
    return entry;
  }

  has(name: string): boolean {
    return this.files.has(name);
  }

  get(name: string): KvFileEntry | undefined {
    return this.files.get(name);
  }

  /** Add a holder for a known file; unknown names are ignored. */
  hold(name: string, holder: string): void {
    this.files.get(name)?.holders.add(holder);
  }

  /**
   * Remove a holder. If the file is now held by nobody, delete it from the
   * ledger and return [name] (the caller deletes it from disk); else [].
   */
  release(name: string, holder: string): string[] {
    const entry = this.files.get(name);
    if (entry === undefined) return [];
    entry.holders.delete(holder);
    if (entry.holders.size > 0) return [];
    this.files.delete(name);
    return [name];
  }

  /** Bump lastUsedAt for a known file. */
  touch(name: string, now = Date.now()): void {
    const entry = this.files.get(name);
    if (entry !== undefined) entry.lastUsedAt = now;
  }

  /** Remove an entry entirely regardless of holders; returns its former holders so callers can clear references. */
  drop(name: string): string[] {
    const entry = this.files.get(name);
    if (entry === undefined) return [];
    this.files.delete(name);
    return [...entry.holders];
  }

  totalBytes(): number {
    let total = 0;
    for (const entry of this.files.values()) total += entry.bytes;
    return total;
  }

  size(): number {
    return this.files.size;
  }

  names(): string[] {
    return [...this.files.keys()];
  }

  entries(): KvFileEntry[] {
    return [...this.files.values()].map((entry) => ({ ...entry, holders: new Set(entry.holders) }));
  }

  /** The MAX measured bytes/token across entries that saved at least one token; undefined if none. */
  bytesPerToken(): number | undefined {
    let max: number | undefined;
    for (const { bytes, tokens } of this.files.values()) {
      if (tokens <= 0) continue;
      const ratio = bytes / tokens;
      if (max === undefined || ratio > max) max = ratio;
    }
    return max;
  }

  /**
   * Choose names to evict when totalBytes() exceeds limitBytes: sort
   * non-protected entries by ascending rankOf(entry) (ties by ascending
   * lastUsedAt, then name), and take them in that order until the running
   * total fits or candidates run out. Does NOT mutate the ledger; the caller
   * calls drop() for each returned name.
   */
  planEviction(
    limitBytes: number,
    rankOf: (entry: KvFileEntry) => number,
    protect: Set<string> = new Set()
  ): string[] {
    let running = this.totalBytes();
    if (running <= limitBytes) return [];

    const candidates = [...this.files.values()]
      .filter((entry) => !protect.has(entry.name))
      .sort((a, b) => rankOf(a) - rankOf(b) || a.lastUsedAt - b.lastUsedAt || (a.name < b.name ? -1 : 1));

    const chosen: string[] = [];
    for (const entry of candidates) {
      if (running <= limitBytes) break;
      running -= entry.bytes;
      chosen.push(entry.name);
    }
    return chosen;
  }
}

export interface KvFingerprint {
  buildInfo?: string;
  modelPath?: string;
  modelFtype?: string;
  nCtxPerSlot?: number;
}

/**
 * KV bytes are only valid for the exact llama.cpp build, model file,
 * quantization and per-slot context; any change invalidates every slot file.
 * The fingerprint id encodes all of them into a stable short identifier.
 */
export function kvFingerprintId(fp: KvFingerprint): string {
  const serialized = JSON.stringify([
    fp.buildInfo ?? null,
    fp.modelPath ?? null,
    fp.modelFtype ?? null,
    fp.nCtxPerSlot ?? null
  ]);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

/** Lower rank is evicted first: cold 0, warm 1, frozen 1, hot 2. */
export function tierRank(tier: KvTier | "frozen"): number {
  return tier === "cold" ? 0 : tier === "hot" ? 2 : 1;
}
