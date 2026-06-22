/**
 * Numeric dotted-version compare. Returns `>0` if `a` is newer than `b`, `<0`
 * if older, `0` if equal. Non-numeric segments count as 0.
 *
 * Note: `platform/nativeUpdate.ts` keeps its own variant on purpose — it bails
 * to `0` (treat as equal → never a spurious update toast) the moment a segment
 * is non-numeric, a stricter fail-safe contract than this one.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (parseInt(pa[i] ?? '0', 10) || 0) - (parseInt(pb[i] ?? '0', 10) || 0);
    if (d !== 0) return d;
  }
  return 0;
}
