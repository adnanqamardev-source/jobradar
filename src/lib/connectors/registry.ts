/**
 * registry.ts — `source_kind` → connector (BE-101).
 *
 * `sources.kind` picks the connector; the worker (`scripts/queue-drain.ts`, then the
 * queue handlers) resolves it here. An unknown kind **fails loudly** rather than
 * skipping the source: a silent skip is how a source quietly stops ingesting for
 * weeks while the dashboard still looks healthy.
 *
 * Registration is explicit, not automatic by import side effect — a connector that
 * registers itself on import cannot be reasoned about, and the integration suite
 * needs to install a fixture connector without touching the module graph.
 */

import { AppError } from "@/lib/errors";

import type { SourceConnector } from "./types";

const registry = new Map<string, SourceConnector>();

/** Which error code an unknown kind raises. */
const UNKNOWN_KIND_CODE = "internal_error" as const;

/**
 * Register a connector for its `kind`. Re-registering the same kind is a
 * programming error: two connectors for one `source_kind` would make ingest
 * results depend on import order.
 */
export function registerConnector(connector: SourceConnector): void {
  const existing = registry.get(connector.kind);
  if (existing && existing !== connector) {
    throw new AppError(UNKNOWN_KIND_CODE, {
      message: `source kind "${connector.kind}" is already registered`,
    });
  }
  registry.set(connector.kind, connector);
}

/**
 * Resolve a connector by `source_kind`.
 *
 * @throws {AppError} `internal_error` naming the kind when nothing is registered.
 */
export function getConnector(kind: string): SourceConnector {
  const connector = registry.get(kind);
  if (!connector) {
    throw new AppError(UNKNOWN_KIND_CODE, {
      message: `no connector registered for source kind "${kind}"`,
    });
  }
  return connector;
}

/** True when `kind` has a connector. For callers that branch rather than throw. */
export function hasConnector(kind: string): boolean {
  return registry.has(kind);
}

/** Registered kinds — the admin health view reads this to flag unconfigured sources. */
export function registeredKinds(): string[] {
  return [...registry.keys()].sort();
}

/** Test-only: drop every registration so one test cannot leak into the next. */
export function clearRegistry(): void {
  registry.clear();
}