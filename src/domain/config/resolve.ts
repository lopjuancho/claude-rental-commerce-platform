/**
 * The ADR 0003 override chain: variant → product → category → organization → platform default.
 * (Weather sensitivity has its own per-hazard resolver in src/domain/weather.)
 * `null`/`undefined` at a level means "inherit". Pure, so availability/pricing code and the
 * database function share one tested definition of precedence.
 */
export const PLATFORM_DEFAULTS = {
  setupBufferMinutes: 60,
  teardownBufferMinutes: 60,
  includedDurationMinutes: 360,
  minBookingLeadTimeMinutes: 720,
  overnightAllowed: false,
} as const;

type Maybe<T> = T | null | undefined;

export interface OrganizationLevel {
  defaultSetupBufferMinutes: number;
  defaultTeardownBufferMinutes: number;
  defaultRentalDurationMinutes: number;
  minBookingLeadTimeMinutes: number;
  overnightAllowed: boolean;
}

export interface CategoryLevel {
  setupBufferMinutes?: Maybe<number>;
  teardownBufferMinutes?: Maybe<number>;
  includedDurationMinutes?: Maybe<number>;
  overnightAllowed?: Maybe<boolean>;
}

export interface ProductLevel extends CategoryLevel {
  minBookingLeadTimeMinutes?: Maybe<number>;
}

export interface VariantLevel {
  setupBufferMinutes?: Maybe<number>;
  teardownBufferMinutes?: Maybe<number>;
}

export interface ResolvedRentalConfig {
  setupBufferMinutes: number;
  teardownBufferMinutes: number;
  includedDurationMinutes: number;
  minBookingLeadTimeMinutes: number;
  overnightAllowed: boolean;
}

function first<T>(...values: Maybe<T>[]): T | undefined {
  for (const v of values) if (v !== null && v !== undefined) return v;
  return undefined;
}

export function resolveRentalConfig(levels: {
  organization?: Maybe<OrganizationLevel>;
  category?: Maybe<CategoryLevel>;
  product?: Maybe<ProductLevel>;
  variant?: Maybe<VariantLevel>;
}): ResolvedRentalConfig {
  const { organization: o, category: c, product: p, variant: v } = levels;
  return {
    setupBufferMinutes:
      first(
        v?.setupBufferMinutes,
        p?.setupBufferMinutes,
        c?.setupBufferMinutes,
        o?.defaultSetupBufferMinutes,
      ) ?? PLATFORM_DEFAULTS.setupBufferMinutes,
    teardownBufferMinutes:
      first(
        v?.teardownBufferMinutes,
        p?.teardownBufferMinutes,
        c?.teardownBufferMinutes,
        o?.defaultTeardownBufferMinutes,
      ) ?? PLATFORM_DEFAULTS.teardownBufferMinutes,
    includedDurationMinutes:
      first(
        p?.includedDurationMinutes,
        c?.includedDurationMinutes,
        o?.defaultRentalDurationMinutes,
      ) ?? PLATFORM_DEFAULTS.includedDurationMinutes,
    minBookingLeadTimeMinutes:
      first(p?.minBookingLeadTimeMinutes, o?.minBookingLeadTimeMinutes) ??
      PLATFORM_DEFAULTS.minBookingLeadTimeMinutes,
    overnightAllowed:
      first(p?.overnightAllowed, c?.overnightAllowed, o?.overnightAllowed) ??
      PLATFORM_DEFAULTS.overnightAllowed,
  };
}
