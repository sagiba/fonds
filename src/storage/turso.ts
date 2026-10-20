import { type Client, type Config, createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql/web";

import { storeForDatabase } from "./sqlite/client.js";
import * as schema from "./sqlite/schema.js";

export { initializeTursoDatabase } from "./sqlite/initialize-libsql.js";

export function databaseForClient(client: Client) {
  const orm = drizzle(client, { schema });
  return storeForDatabase(orm, client, "turso");
}

export function openTursoDatabase(config: Config) {
  const url = new URL(config.url);
  if (
    !["libsql:", "https:", "wss:"].includes(url.protocol) ||
    config.tls === false ||
    url.searchParams.getAll("tls").some((value) => value !== "1")
  ) {
    throw new Error("Remote financial storage requires encrypted transport");
  }
  return databaseForClient(createClient({ ...config, intMode: "number" }));
}
