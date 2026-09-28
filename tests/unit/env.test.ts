import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/server/env";

const base = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-placeholder-publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-placeholder-service-role-key",
};

describe("parseServerEnv", () => {
  it("defaults APP_ENV to development", () => {
    expect(parseServerEnv(base).APP_ENV).toBe("development");
  });

  it("rejects a missing service role key without echoing secrets", () => {
    const run = () =>
      parseServerEnv({
        ...base,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_secretish_value",
      });
    expect(run).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(run).not.toThrow(/secretish/);
  });

  it("forbids DEV_TENANT_SLUG in production", () => {
    expect(() =>
      parseServerEnv({
        ...base,
        NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
        APP_ENV: "production",
        DEV_TENANT_SLUG: "acme",
      }),
    ).toThrow(/DEV_TENANT_SLUG/);
  });

  it("requires https for Supabase outside development", () => {
    expect(() => parseServerEnv({ ...base, APP_ENV: "staging" })).toThrow(/https/);
    expect(
      parseServerEnv({
        ...base,
        APP_ENV: "staging",
        NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      }).APP_ENV,
    ).toBe("staging");
  });

  it("validates the platform root domain", () => {
    expect(() => parseServerEnv({ ...base, PLATFORM_ROOT_DOMAIN: "https://bad" })).toThrow(
      /PLATFORM_ROOT_DOMAIN/,
    );
  });
});
