export function classifyState(
  sentence: string,
  at: number,
  stateLength: number,
): "A" | "B" | "C" | "D" | "E";
export function unsupportedStateClaims(reply: string | null | undefined): string[];
export function availabilityClaims(reply: string): string[];
export function leaksServerRefs(raw: string): boolean;
export function safeExcerpt(text: string | null | undefined, max?: number): string;
export function expectedWhen(isoDate: string, start?: string, end?: string): string;
export interface Verdict {
  ok: boolean;
  reasons: string[];
}
export function freshAvailabilityVerdict(
  card: { product?: { slug?: string }; when?: string; quantity?: number; status?: string } | null,
  expected: { slug: string; when: string; quantity: number },
): Verdict;
export function availabilityReplayVerdict(
  reply: string | null | undefined,
  blocks: { type: string }[] | undefined,
): Verdict;
export function bookingReplayVerdict(
  reply: string | null | undefined,
  blocks: { type: string; quoteNumber?: string; status?: string }[] | undefined,
  expected: { quoteNumber: string; status: string },
): Verdict;
export interface Observed {
  modelCalls?: number | string | null;
  telemetry?: string | null;
}
export function providerObservationVerdict(input: {
  first: Observed | null | undefined;
  replay: Observed | null | undefined;
  dbBefore: number;
  dbAfter: number;
}): Verdict;
export function smokeExitCode(input: {
  failedChecks: number;
  bookingCleanup: string;
  blockCleanup: string;
  recovery: string[];
}): 0 | 1;
