import type { DrugResult } from "./types";

const KEY_PREFIX = "fda_lookup_v1_";
const DEFAULT_TTL_DAYS = 7;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const probe = "__fda_probe__";
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

function ttlMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

export function cacheKey(normalizedName: string): string {
  return KEY_PREFIX + normalizedName.toLowerCase();
}

export function readCache(
  normalizedName: string,
  ttlDays = DEFAULT_TTL_DAYS
): DrugResult | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(cacheKey(normalizedName));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DrugResult;
    const at = Date.parse(parsed.lookedUpAt);
    if (!Number.isFinite(at)) return null;
    if (Date.now() - at > ttlMs(ttlDays)) return null;
    return { ...parsed, cached: true };
  } catch {
    return null;
  }
}

export function writeCache(result: DrugResult): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(cacheKey(result.normalizedName), JSON.stringify(result));
  } catch {
    // Quota / privacy mode — caching is best-effort.
  }
}

export function clearCache(): number {
  const s = storage();
  if (!s) return 0;
  const toRemove: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k && k.startsWith(KEY_PREFIX)) toRemove.push(k);
  }
  toRemove.forEach((k) => s.removeItem(k));
  return toRemove.length;
}
