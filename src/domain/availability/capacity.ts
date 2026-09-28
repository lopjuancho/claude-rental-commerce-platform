import { type Interval, intersect } from "./interval";

export interface Usage {
  period: Interval;
  quantity: number;
}

/**
 * Maximum quantity in simultaneous use inside `window` (sweep line). Ends are processed before
 * starts at the same instant, so back-to-back usages don't add up. Mirrors SQL app.peak_usage.
 */
export function peakUsage(window: Interval, usages: readonly Usage[]): number {
  const events: [time: number, delta: number][] = [];
  for (const u of usages) {
    const clipped = intersect(window, u.period);
    if (!clipped || u.quantity <= 0) continue;
    events.push([clipped.start, u.quantity], [clipped.end, -u.quantity]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let level = 0;
  let peak = 0;
  for (const [, delta] of events) {
    level += delta;
    if (level > peak) peak = level;
  }
  return peak;
}

/** Pooled availability: capacity minus peak concurrent use (never negative). */
export function pooledAvailable(
  capacity: number,
  window: Interval,
  usages: readonly Usage[],
): number {
  return Math.max(capacity - peakUsage(window, usages), 0);
}
