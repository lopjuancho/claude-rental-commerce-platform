import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createSmokeCleanup,
  PRE_TURN_REFUSALS,
  preTurnRefusal,
  trackedExchange,
} from "../../scripts/ai-smoke-db.mjs";

/**
 * The smoke's transport tracking (L5) and pre-turn refusal recognition, without a database: an
 * empty fake journal (no conversation, no turn, no smoke quote) — so the ONLY thing that can make
 * a request terminal is a recognized application refusal for every delivery.
 */
const emptyDb = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
};
const TAG = "ai-smoke-0123456789ab";
const ORG = "00000000-0000-4000-8000-000000000001";
function cleanupFor() {
  const cleanup = createSmokeCleanup(emptyDb, TAG);
  cleanup.state.organizationId = ORG;
  return cleanup;
}
const response = (status: number, text: () => Promise<string>) => ({ status, text });
const json = (status: number, body: unknown) =>
  response(status, () => Promise.resolve(JSON.stringify(body)));

describe("trackedExchange: the WHOLE HTTP exchange is one delivery (L5)", () => {
  it("headers arrived but the body read failed → transport_failed_unknown, tracking cleared, unresolved", async () => {
    const cleanup = cleanupFor();
    await expect(
      trackedExchange(cleanup, "req-body-fails", "s", () =>
        Promise.resolve(response(200, () => Promise.reject(new Error("socket reset")))),
      ),
    ).rejects.toThrow("socket reset");
    const intent = cleanup.state.requests.get("req-body-fails")!;
    expect(intent.state).toBe("transport_failed_unknown");
    expect(intent.sends).toEqual([
      { state: "transport_failed_unknown", httpStatus: null, refusal: null },
    ]);
    expect(cleanup.state.inFlight).toBeNull();
    const state = await cleanup.run();
    expect(state.bookingOutcome).toBe("unresolved");
    expect(state.unresolved.join(" ")).toMatch(/req-body-fails: completion not established/);
    expect(cleanup.recovery().join("\n")).toContain("req-body-fails");
  });

  it("the request itself failed → transport_failed_unknown", async () => {
    const cleanup = cleanupFor();
    await expect(
      trackedExchange(cleanup, "req-fetch-fails", "s", () =>
        Promise.reject(new Error("ECONNRESET")),
      ),
    ).rejects.toThrow();
    expect(cleanup.state.requests.get("req-fetch-fails")!.state).toBe("transport_failed_unknown");
    expect(cleanup.state.inFlight).toBeNull();
  });

  it("while the body is still being read the delivery is in_flight and tracked", async () => {
    const cleanup = cleanupFor();
    let finish!: (s: string) => void;
    const p = trackedExchange(cleanup, "req-slow-body", "s", () =>
      Promise.resolve(response(200, () => new Promise<string>((r) => (finish = r)))),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(cleanup.state.requests.get("req-slow-body")!.state).toBe("in_flight");
    expect(cleanup.state.inFlight).not.toBeNull();
    // An interrupt whose bounded wait runs out: UNKNOWN.
    const state = await cleanup.run({ waitForInFlightMs: 20 });
    expect(cleanup.state.requests.get("req-slow-body")!.state).toBe("wait_timed_out_unknown");
    expect(state.bookingOutcome).toBe("unresolved");
    finish("{}");
    await p;
  });

  it("full body received but not JSON → transport completed, no application outcome: unresolved", async () => {
    // Chosen state: the HTTP exchange finished (response_completed), but a body that is not the
    // application's JSON proves nothing about the request — never a recognized refusal.
    const cleanup = cleanupFor();
    const r = await trackedExchange(cleanup, "req-html", "s", () =>
      Promise.resolve(response(502, () => Promise.resolve("<html>Bad gateway</html>"))),
    );
    expect(r.body).toBeNull();
    expect(cleanup.state.requests.get("req-html")!.sends).toEqual([
      { state: "response_completed", httpStatus: 502, refusal: null },
    ]);
    expect((await cleanup.run()).bookingOutcome).toBe("unresolved");
  });

  it("a recognized application pre-turn refusal for EVERY delivery → terminal; one unknown → not", async () => {
    const cleanup = cleanupFor();
    await trackedExchange(cleanup, "req-refused", "s", () =>
      Promise.resolve(json(429, { status: "error", errorCode: "RATE_LIMITED", reply: "…" })),
    );
    await trackedExchange(cleanup, "req-refused", "s", () =>
      Promise.resolve(json(409, { status: "error", errorCode: "BUSY", reply: "…" })),
    );
    const ok = await cleanup.run();
    expect(ok.bookingOutcome).toBe("reconciled_no_booking_terminal");
    expect(cleanup.recovery()).toEqual([]);
    // A third delivery of the same key whose body read failed: the key is no longer proven.
    await expect(
      trackedExchange(cleanup, "req-refused", "s", () =>
        Promise.resolve(response(200, () => Promise.reject(new Error("reset")))),
      ),
    ).rejects.toThrow();
    expect((await cleanup.run()).bookingOutcome).toBe("unresolved");
  });
});

describe("preTurnRefusal: only the application's own pre-turn refusals", () => {
  it.each([
    [400, "INVALID_MESSAGE"],
    [409, "SESSION_REQUIRED"],
    [409, "BUSY"],
    [413, "TOO_LARGE"],
    [415, "UNSUPPORTED"],
    [429, "RATE_LIMITED"],
  ])("%i %s is recognized", (status, errorCode) => {
    expect(preTurnRefusal(status, { status: "error", errorCode, reply: "x" })).toBe(errorCode);
  });
  it.each([
    [502, null],
    [504, null],
    [503, { status: "error", errorCode: "AI_UNAVAILABLE" }],
    [200, { status: "ok", reply: "Hi" }],
    [409, { status: "error", errorCode: "IN_PROGRESS" }],
    [429, null],
    [429, { errorCode: "RATE_LIMITED" }],
    [400, { status: "error", errorCode: "RATE_LIMITED" }],
  ])("%i %j is NOT", (status, body) => {
    expect(preTurnRefusal(status, body)).toBeNull();
  });

  it("matches the handler: every listed refusal is returned BEFORE runTurn; nothing after it is listed", () => {
    const src = readFileSync("src/server/ai/handler.ts", "utf8");
    const turnAt = src.indexOf("result = await runTurn(");
    expect(turnAt).toBeGreaterThan(0);
    for (const [status, codes] of Object.entries(PRE_TURN_REFUSALS)) {
      for (const code of codes) {
        if (code === "BUSY") continue; // from runTurn's claim, before any turn is created (below)
        const at = src.search(new RegExp(`fail\\(\\s*${status},\\s*"${code}"`));
        expect(at, `${status} ${code}`).toBeGreaterThan(0);
        expect(at, `${status} ${code} before runTurn`).toBeLessThan(turnAt);
      }
    }
    // AI_UNAVAILABLE is returned after runTurn may have started a turn: never a refusal.
    expect(src.indexOf('"AI_UNAVAILABLE"')).toBeGreaterThan(turnAt);
    // BUSY: runTurn returns it straight from the claim, which created no turn (ai_turn_begin).
    const assistant = readFileSync("src/server/ai/assistant.ts", "utf8");
    expect(assistant).toMatch(
      /claim\.outcome === "in_progress" \|\| claim\.outcome === "busy" \|\| !claim\.turnId\) \{\s*return \{/,
    );
    expect(src).toMatch(
      /result\.errorCode === "IN_PROGRESS" \|\| result\.errorCode === "BUSY" \? 409/,
    );
  });
});
