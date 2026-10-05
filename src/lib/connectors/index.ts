/**
 * index.ts — the connector seam's public surface.
 *
 * Connectors themselves are imported explicitly by the caller that owns them
 * (BE-102..BE-104 register their own), so this barrel deliberately exports the
 * contract and the helpers, not a list of connectors.
 */

export {
  HTTP_DEFAULTS,
  defaultRunCtx,
  type CostClass,
  type ProviderSchema,
  type RawJob,
  type RunCtx,
  type SourceConfig,
  type SourceConnector,
} from "./types";
export { fetchJson, type FetchJsonOptions } from "./http";
export {
  clearRegistry,
  getConnector,
  hasConnector,
  registerConnector,
  registeredKinds,
} from "./registry";