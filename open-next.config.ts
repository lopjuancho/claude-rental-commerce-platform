import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Phase 1 renders tenant pages dynamically (host-dependent), so no incremental
// cache is configured. Add an R2/KV cache here if ISR is introduced.
export default defineCloudflareConfig({});
