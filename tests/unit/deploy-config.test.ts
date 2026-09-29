import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guards the Worker deployment configuration: production can only be deployed with an explicit
 * --env production, and the development config (APP_ENV=development) can never land on the
 * production Worker.
 */
type Env = {
  name: string;
  services: { binding: string; service: string }[];
  vars: { APP_ENV: string };
  ratelimits: { name: string; namespace_id: string }[];
};
type Wrangler = Env & { env: Record<string, Env> };

// wrangler.jsonc uses full-line // comments and trailing commas only.
const wrangler = JSON.parse(
  readFileSync("wrangler.jsonc", "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1"),
) as Wrangler;
const scripts = (
  JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
).scripts;

const envs = {
  development: wrangler,
  staging: wrangler.env.staging!,
  production: wrangler.env.production!,
};

const selfRef = (e: Env) => e.services.find((s) => s.binding === "WORKER_SELF_REFERENCE")?.service;

const deploy = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", ["scripts/deploy.sh", ...args], {
    encoding: "utf8",
    env: { ...process.env, WORKERS_CI: "", CLOUDFLARE_ENV: "", ...env },
  });

describe("Worker environments", () => {
  it("uses one distinct Worker per environment", () => {
    expect(envs.production.name).toBe("claude-rental-commerce-platform");
    expect(envs.staging.name).toBe("rental-commerce-staging");
    expect(envs.development.name).toBe("rental-commerce-development");
    expect(Object.keys(wrangler.env).sort()).toEqual(["production", "staging"]);
  });

  it.each(Object.entries(envs))("%s: WORKER_SELF_REFERENCE points at its own Worker", (_, e) => {
    expect(selfRef(e)).toBe(e.name);
  });

  it.each(Object.entries(envs))("%s: APP_ENV matches the environment", (name, e) => {
    expect(e.vars.APP_ENV).toBe(name);
  });

  it("keeps the rate limiter namespaces fixed per environment", () => {
    const ids = (e: Env) => e.ratelimits.map((r) => `${r.name}=${r.namespace_id}`);
    const names = [
      "AUTH_RATE_LIMITER",
      "PUBLIC_WRITE_RATE_LIMITER",
      "ASSISTANT_RATE_LIMITER",
      "PUBLIC_QUERY_RATE_LIMITER",
    ];
    const expected = (base: number) => names.map((n, i) => `${n}=${base + i + 1}`);
    expect(ids(envs.development)).toEqual(expected(1000));
    expect(ids(envs.staging)).toEqual(expected(2000));
    expect(ids(envs.production)).toEqual(expected(3000));
  });
});

describe("deploy scripts", () => {
  it("has explicit per-environment scripts and a generic deploy that refuses", () => {
    expect(scripts["deploy:production"]).toBe("bash scripts/deploy.sh production");
    expect(scripts["deploy:staging"]).toBe("bash scripts/deploy.sh staging");
    expect(scripts["deploy:development"]).toBe("bash scripts/deploy.sh development");
    expect(scripts.deploy).toMatch(/exit 1$/);
    expect(scripts.deploy).not.toMatch(/opennextjs-cloudflare|wrangler/);
  });

  it("only scripts/deploy.sh deploys", () => {
    for (const [name, cmd] of Object.entries(scripts)) {
      if (name.startsWith("deploy:")) continue;
      expect(cmd, name).not.toMatch(/(opennextjs-cloudflare|wrangler) (deploy|versions)/);
    }
  });

  it("passes --env for production and staging", () => {
    const sh = readFileSync("scripts/deploy.sh", "utf8");
    expect(sh).toContain('production | staging) env_args=(--env "$target")');
    expect(sh).toMatch(/opennextjs-cloudflare build \$\{env_args/);
    expect(sh).toMatch(/opennextjs-cloudflare deploy \$\{env_args/);
  });

  it("refuses a missing or unknown target", () => {
    expect(deploy([]).status).toBe(1);
    expect(deploy(["prod"]).status).toBe(1);
  });

  it("refuses the development config inside a Cloudflare build", () => {
    const r = deploy(["development"], { WORKERS_CI: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would replace production");
  });

  it("refuses a conflicting CLOUDFLARE_ENV", () => {
    expect(deploy(["development"], { CLOUDFLARE_ENV: "production" }).status).toBe(1);
    expect(deploy(["staging"], { CLOUDFLARE_ENV: "production" }).status).toBe(1);
    expect(deploy(["production"], { CLOUDFLARE_ENV: "staging" }).status).toBe(1);
  });
});
