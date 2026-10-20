/** Storage/application import compatibility only; this is not a hosted HTTP server. */
export type { FinancialStore } from "../application/financial-store.js";
export { createApplication } from "../application/operations.js";
export type {
  ProviderCollector,
  SourceAdapter,
} from "../domain/source-adapter.js";
export {
  databaseForClient,
  initializeTursoDatabase,
  openTursoDatabase,
} from "../storage/turso.js";
