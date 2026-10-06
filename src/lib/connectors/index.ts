/**
 * index.ts — the connector seam's public surface.
 *
 * The contract and helpers are exported from here; the connectors themselves are named
 * exports so a caller imports exactly the source it needs. `scripts/queue-drain.ts` and the
 * queue handlers resolve through `registry.ts` rather than importing all of them, so an
 * unused connector never enters a worker bundle.
 *
 * `installBuiltInConnectors()` is the one exception: it registers everything, for the
 * worker entry point that genuinely dispatches on `source_kind`.
 */

export {
  HTTP_DEFAULTS,
  JOB_API_TIMEOUT_MS,
  defaultRunCtx,
  type CostClass,
  type ProviderSchema,
  type RawJob,
  type RunCtx,
  type SourceConfig,
  type SourceConnector,
} from "./types";
export { fetchJson, joinUrl, type FetchJsonOptions } from "./http";
export {
  clearRegistry,
  getConnector,
  hasConnector,
  registerConnector,
  registeredKinds,
} from "./registry";
export { assertScrapeUrl, checkScrapeUrl, type UrlCheck, type UrlRejection } from "./url-guard";

export { greenhouseConnector } from "./greenhouse";
export { leverConnector } from "./lever";
export { ashbyConnector } from "./ashby";
export { remotiveConnector, REMOTIVE_MIN_INTERVAL_MS } from "./remotive";
export { arbeitnowConnector } from "./arbeitnow";
export { usajobsConnector } from "./usajobs";
export { adzunaConnector } from "./adzuna";
export { firecrawlMap, firecrawlScrapeConnector, firecrawlSearchConnector } from "./firecrawl";

import { adzunaConnector } from "./adzuna";
import { arbeitnowConnector } from "./arbeitnow";
import { ashbyConnector } from "./ashby";
import { firecrawlScrapeConnector, firecrawlSearchConnector } from "./firecrawl";
import { greenhouseConnector } from "./greenhouse";
import { leverConnector } from "./lever";
import { remotiveConnector } from "./remotive";
import { registerConnector } from "./registry";
import { usajobsConnector } from "./usajobs";

/**
 * Register every connector in this directory.
 *
 * Idempotent — `registerConnector` throws on a genuine double-registration but accepts the
 * identical connector twice, so calling this from more than one entry point is safe.
 */
export function installBuiltInConnectors(): void {
  for (const connector of [
    greenhouseConnector,
    leverConnector,
    ashbyConnector,
    remotiveConnector,
    arbeitnowConnector,
    usajobsConnector,
    adzunaConnector,
    firecrawlScrapeConnector,
    firecrawlSearchConnector,
  ]) {
    registerConnector(connector);
  }
}