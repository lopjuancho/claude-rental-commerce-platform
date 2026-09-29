import { describe, expect, it, vi } from "vitest";
import {
  normalizeAddress,
  type PostalAddress,
  postalAddressSchema,
} from "@/domain/delivery/address";
import { METERS_PER_MILE, mileageFee, type MileageSettings } from "@/domain/delivery/mileage";
import type {
  DistanceCache,
  DistanceProvider,
  RoadDistanceResult,
} from "@/domain/delivery/provider";
import { type DeliveryConfig, quoteDelivery, routeKey } from "@/domain/delivery/quote";

const miles = (m: number) => m * METERS_PER_MILE;
const TIKY: MileageSettings = {
  freeMiles: 5,
  perMileRateCents: 400,
  maximumMiles: null,
  rounding: "ceil_whole_mile",
  basis: "one_way",
};

describe("mileage fee (first 5 miles free, then $4/mi, rounded up)", () => {
  it.each([
    [0, 0, 0],
    [4.99, 0, 0],
    [5, 0, 0], // exactly 5 miles = $0
    [5.01, 1, 400],
    [5.1, 1, 400], // 5.1 mi → 1 billable mile
    [6, 1, 400],
    [8.2, 4, 1600], // the documented example: ceil(8.2 − 5) = 4 → $16
    [25.3, 21, 8400],
  ])("%s mi → %s billable mi → %s¢", (distance, billable, fee) => {
    expect(mileageFee(miles(distance), TIKY)).toMatchObject({
      status: "priced",
      billableMiles: billable,
      feeCents: fee,
    });
  });

  it("uses hundredths of a mile so float noise cannot tip the rounding", () => {
    expect(mileageFee(8046.72, TIKY)).toMatchObject({ distanceMiles: 5, feeCents: 0 }); // 5 mi to the millimetre
    expect(mileageFee(8046.72 + 0.5, TIKY)).toMatchObject({ feeCents: 0 }); // < 0.01 mi more
  });

  it("round-trip basis doubles the road distance before free miles (future configuration)", () => {
    expect(mileageFee(miles(8.2), { ...TIKY, basis: "round_trip" })).toMatchObject({
      chargedMiles: 16.4,
      billableMiles: 12,
      feeCents: 4800,
    });
    expect(mileageFee(miles(2.5), { ...TIKY, basis: "round_trip" })).toMatchObject({
      billableMiles: 0,
      feeCents: 0,
    });
  });

  it("other rounding methods", () => {
    expect(mileageFee(miles(8.2), { ...TIKY, rounding: "round_whole_mile" })).toMatchObject({
      billableMiles: 3,
      feeCents: 1200,
    });
    expect(mileageFee(miles(8.5), { ...TIKY, rounding: "round_whole_mile" })).toMatchObject({
      billableMiles: 4,
    });
    expect(mileageFee(miles(8.2), { ...TIKY, rounding: "none" })).toMatchObject({
      billableMiles: 3.2,
      feeCents: 1280,
    });
  });

  it("beyond a configured maximum → manual review; no maximum → priced", () => {
    expect(mileageFee(miles(40), { ...TIKY, maximumMiles: 30 })).toEqual({
      status: "manual_review",
      reason: "OUTSIDE_MAX_DISTANCE",
      distanceMiles: 40,
    });
    expect(mileageFee(miles(30), { ...TIKY, maximumMiles: 30 }).status).toBe("priced");
    expect(mileageFee(miles(140), TIKY).status).toBe("priced");
  });
});

describe("address normalization and validation", () => {
  const a: PostalAddress = {
    line1: "2560 Overton Crossing Street",
    city: "Memphis",
    state: "TN",
    postalCode: "38127",
  };
  it("normalizes spelling/punctuation variants to the same cache key", async () => {
    const b: PostalAddress = {
      line1: "2560  overton crossing st.",
      city: "MEMPHIS",
      state: "TN",
      postalCode: "38127-1234",
    };
    expect(normalizeAddress(a)).toBe(normalizeAddress(b));
    expect(await routeKey(a, b)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("different addresses give different keys; direction matters", async () => {
    const c: PostalAddress = { ...a, line1: "2562 Overton Crossing St" };
    expect(await routeKey(a, c)).not.toBe(await routeKey(c, a));
  });
  it("validates US addresses", () => {
    expect(postalAddressSchema.safeParse({ ...a, state: "tn" }).data?.state).toBe("TN");
    expect(postalAddressSchema.safeParse({ ...a, postalCode: "3812" }).success).toBe(false);
    expect(postalAddressSchema.safeParse({ ...a, state: "Tennessee" }).success).toBe(false);
  });
});

describe("quoteDelivery", () => {
  const depot: PostalAddress = {
    line1: "2560 Overton Crossing St",
    city: "Memphis",
    state: "TN",
    postalCode: "38127",
  };
  const event: PostalAddress = {
    line1: "1930 S Germantown Rd",
    city: "Germantown",
    state: "TN",
    postalCode: "38138",
  };
  const config: DeliveryConfig = {
    depot,
    freeMiles: 5,
    perMileRateCents: 400,
    maximumMiles: null,
    rounding: "ceil_whole_mile",
    basis: "one_way",
  };
  const noAreas = { areasConfigured: false, match: null };

  const provider = (result: RoadDistanceResult | Error): DistanceProvider & { calls: number } => {
    const p = {
      id: "fake",
      version: "1",
      calls: 0,
      getRoadDistance: () => {
        p.calls++;
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    };
    return p;
  };
  const memoryCache = (): DistanceCache & { store: Map<string, number> } => {
    const store = new Map<string, number>();
    return {
      store,
      get: (k) => Promise.resolve(store.get(`${k.provider}/${k.version}/${k.routeKey}`) ?? null),
      put: (k, m) => {
        store.set(`${k.provider}/${k.version}/${k.routeKey}`, m);
        return Promise.resolve();
      },
    };
  };
  const quote = (
    p: DistanceProvider | null,
    cache: DistanceCache | null = null,
    patch: Partial<Parameters<typeof quoteDelivery>[0]> = {},
  ) =>
    quoteDelivery({
      destination: event,
      config,
      area: noAreas,
      provider: p,
      cache,
      currency: "USD",
      ...patch,
    });

  it("prices one-way road distance: 8.2 mi → $16", async () => {
    expect(await quote(provider({ ok: true, meters: miles(8.2) }))).toMatchObject({
      status: "priced",
      method: "mileage",
      feeCents: 1600,
      distanceMiles: 8.2,
      billableMiles: 4,
      label: "Delivery (8.2 mi: 4 billable mi × $4.00)",
    });
  });

  it.each([
    ["provider failure", provider({ ok: false, reason: "PROVIDER_ERROR" }), "PROVIDER_ERROR"],
    ["provider throws / network error", provider(new Error("socket hang up")), "PROVIDER_ERROR"],
    [
      "unresolvable address",
      provider({ ok: false, reason: "ADDRESS_NOT_FOUND" }),
      "ADDRESS_NOT_FOUND",
    ],
    [
      "ambiguous address",
      provider({ ok: false, reason: "AMBIGUOUS_ADDRESS" }),
      "AMBIGUOUS_ADDRESS",
    ],
    ["no route", provider({ ok: false, reason: "NO_ROUTE" }), "NO_ROUTE"],
  ])("%s → manual review, no price", async (_label, p, reason) => {
    expect(await quote(p)).toEqual({ status: "manual_review", reason });
  });

  it("missing configuration → manual review", async () => {
    const p = provider({ ok: true, meters: 1 });
    expect(await quote(null)).toEqual({
      status: "manual_review",
      reason: "DISTANCE_PROVIDER_NOT_CONFIGURED",
    });
    expect(await quote(p, null, { config: { ...config, depot: null } })).toEqual({
      status: "manual_review",
      reason: "DEPOT_NOT_CONFIGURED",
    });
    expect(await quote(p, null, { config: { ...config, perMileRateCents: null } })).toEqual({
      status: "manual_review",
      reason: "MILEAGE_NOT_CONFIGURED",
    });
  });

  it("outside configured service areas → manual review; flat areas skip the provider", async () => {
    const p = provider({ ok: true, meters: miles(8.2) });
    expect(await quote(p, null, { area: { areasConfigured: true, match: null } })).toEqual({
      status: "manual_review",
      reason: "OUTSIDE_SERVICE_AREA",
    });
    const flat = await quote(p, null, {
      area: {
        areasConfigured: true,
        match: { id: "a1", revision: 2, name: "Zone A", pricing: "flat", flatFeeCents: 3500 },
      },
    });
    expect(flat).toMatchObject({
      status: "priced",
      method: "flat",
      feeCents: 3500,
      serviceAreaId: "a1",
      serviceAreaRevision: 2,
    });
    expect(p.calls).toBe(0);
    expect(
      await quote(p, null, {
        area: {
          areasConfigured: true,
          match: {
            id: "a2",
            revision: 1,
            name: "Far",
            pricing: "manual_review",
            flatFeeCents: null,
          },
        },
      }),
    ).toEqual({
      status: "manual_review",
      reason: "SERVICE_AREA_REQUIRES_REVIEW",
    });
  });

  it("no destination (customer pickup) → not requested", async () => {
    expect(await quote(provider({ ok: true, meters: 1 }), null, { destination: null })).toEqual({
      status: "not_requested",
    });
  });

  describe("cache behaviour", () => {
    it("a miss calls the provider once and stores the distance; a hit does not call it again", async () => {
      const cache = memoryCache();
      const p = provider({ ok: true, meters: miles(8.2) });
      await quote(p, cache);
      await quote(p, cache);
      expect(p.calls).toBe(1);
      expect(cache.store.size).toBe(1);
    });

    it("a different provider version misses the cache", async () => {
      const cache = memoryCache();
      await quote(provider({ ok: true, meters: miles(8.2) }), cache);
      const v2 = { ...provider({ ok: true, meters: miles(9) }), version: "2" };
      const spy = vi.spyOn(v2, "getRoadDistance");
      expect(await quote(v2, cache)).toMatchObject({ feeCents: 1600 });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("failures are not cached", async () => {
      const cache = memoryCache();
      await quote(provider({ ok: false, reason: "PROVIDER_ERROR" }), cache);
      expect(cache.store.size).toBe(0);
    });

    it("cache outages never block pricing", async () => {
      const broken: DistanceCache = {
        get: () => Promise.reject(new Error("db down")),
        put: () => Promise.reject(new Error("db down")),
      };
      expect(await quote(provider({ ok: true, meters: miles(8.2) }), broken)).toMatchObject({
        status: "priced",
        feeCents: 1600,
      });
    });

    it("the rate is applied after the cache: changing $/mile re-prices a cached distance", async () => {
      const cache = memoryCache();
      const p = provider({ ok: true, meters: miles(8.2) });
      await quote(p, cache);
      expect(await quote(p, cache, { config: { ...config, perMileRateCents: 500 } })).toMatchObject(
        { feeCents: 2000 },
      );
      expect(p.calls).toBe(1);
    });
  });
});
