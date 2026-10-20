/** One numbered forward migration: the exact SQL of `migrations/…/NNNN_name.sql`. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** A database recorded at a migration this release does not have. */
export class NewerSchemaError extends Error {
  constructor(version: number, latest: number) {
    super(
      `Database schema is at migration ${version}, newer than this Fonds release (migration ${latest}); use a compatible release, or explicitly recreate an obsolete pre-release database`,
    );
    this.name = "NewerSchemaError";
  }
}

/** How one backend runs migrations; everything else is shared. */
export interface MigrationTarget<Tx> {
  /** Runs `work` in one transaction that holds the database's migration lock. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** The last applied migration; 0 for an empty database. */
  version(tx: Tx): Promise<number>;
  /** Executes a migration's SQL and records its version. */
  apply(tx: Tx, migration: Migration): Promise<void>;
}

/**
 * Applies the pending migrations in order and validates the result, all in
 * one locked transaction: concurrent starts apply each migration once, and an
 * interrupted or refused migration leaves the previous version. An up-to-date
 * database runs no migration SQL and writes no version. A database newer than
 * the release is refused.
 */
export async function migrate<Tx>(
  target: MigrationTarget<Tx>,
  migrations: readonly Migration[],
  /** Validates the result; `from` is the version before this migration. */
  check?: (tx: Tx, from: number) => Promise<void>,
): Promise<void> {
  await target.transaction(async (tx) => {
    const version = await target.version(tx);
    const latest = migrations.at(-1)?.version ?? 0;
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error("Unsupported database schema version");
    }
    if (version > latest) {
      throw new NewerSchemaError(version, latest);
    }
    for (const migration of migrations) {
      if (migration.version > version) {
        await target.apply(tx, migration);
      }
    }
    await check?.(tx, version);
  });
}
