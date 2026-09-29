import { describe, expect, it, vi } from "vitest";
import type { PostalAddress } from "@/domain/delivery/address";
import { GoogleRoutesDistanceProvider } from "@/server/delivery/providers/google-routes";

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

const reply = (status: number, body: unknown) =>
  vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );

const provider = (fetchImpl: typeof fetch) =>
  new GoogleRoutesDistanceProvider("test-key-0123456789abcdef", fetchImpl);

describe("GoogleRoutesDistanceProvider", () => {
  it("requests a DRIVE route by address with a minimal field mask and returns road meters", async () => {
    const fetchImpl = reply(200, {
      routes: [{ distanceMeters: 13196 }],
      geocodingResults: { origin: {}, destination: {} },
    });
    expect(await provider(fetchImpl).getRoadDistance(depot, event)).toEqual({
      ok: true,
      meters: 13196,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Goog-FieldMask"]).toBe("routes.distanceMeters,geocodingResults");
    expect(headers["X-Goog-Api-Key"]).toBe("test-key-0123456789abcdef");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      origin: { address: "2560 Overton Crossing St, Memphis, TN 38127" },
      destination: { address: "1930 S Germantown Rd, Germantown, TN 38138" },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
    });
  });

  it("treats an omitted distance on a returned route as zero", async () => {
    expect(await provider(reply(200, { routes: [{}] })).getRoadDistance(depot, depot)).toEqual({
      ok: true,
      meters: 0,
    });
  });

  it.each([
    [
      "destination geocoding failure",
      reply(200, {
        geocodingResults: { destination: { geocoderStatus: { code: 5, message: "NOT_FOUND" } } },
      }),
      "ADDRESS_NOT_FOUND",
    ],
    [
      "partial address match",
      reply(200, {
        routes: [{ distanceMeters: 5 }],
        geocodingResults: { destination: { partialMatch: true } },
      }),
      "AMBIGUOUS_ADDRESS",
    ],
    [
      "400 about the address",
      reply(400, {
        error: { status: "INVALID_ARGUMENT", message: "Invalid destination address." },
      }),
      "ADDRESS_NOT_FOUND",
    ],
    ["no route", reply(200, { routes: [] }), "NO_ROUTE"],
    [
      "depot geocoding failure (configuration problem)",
      reply(200, { geocodingResults: { origin: { geocoderStatus: { code: 5 } } } }),
      "PROVIDER_ERROR",
    ],
    [
      "invalid key / quota",
      reply(403, { error: { status: "PERMISSION_DENIED", message: "API key not valid." } }),
      "PROVIDER_ERROR",
    ],
    ["server error", reply(500, { error: { status: "INTERNAL" } }), "PROVIDER_ERROR"],
    ["malformed JSON", reply(200, "<html>"), "PROVIDER_ERROR"],
    [
      "network failure / timeout",
      vi.fn(() => Promise.reject(new DOMException("timeout", "TimeoutError"))),
      "PROVIDER_ERROR",
    ],
  ])("%s → %s", async (_label, fetchImpl, reason) => {
    expect(
      await provider(fetchImpl as unknown as typeof fetch).getRoadDistance(depot, event),
    ).toEqual({ ok: false, reason });
  });
});
