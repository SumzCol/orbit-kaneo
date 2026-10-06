import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import journal from "../../apps/api/drizzle/meta/_journal.json";
import db from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";

beforeEach(async () => {
  await resetTestDatabase();
});

// Resolved through the journal so a renumbering on a later sync does not
// break it.
const catchUpPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/api/drizzle",
  `${
    journal.entries.find((entry) =>
      entry.tag.endsWith("_orbit_upstream_catch_up"),
    )?.tag
  }.sql`,
);

describe("the catch-up for upstream's 0056-0058", () => {
  // Orbit's production database recorded its own 0056-0058 with later
  // timestamps than upstream's, so drizzle never runs upstream's three there.
  // This is that database: upstream's objects missing, the rest in place.
  it("restores what a database that skipped them lacks, and can run again", async () => {
    const rollback = new Error("rollback");

    await expect(
      db.transaction(async (tx) => {
        for (const statement of [
          "DROP TRIGGER IF EXISTS asset_storage_cleanup ON asset",
          "DROP TRIGGER IF EXISTS project_storage_cleanup ON project",
          "DROP FUNCTION IF EXISTS queue_deleted_storage_object()",
          'DROP INDEX IF EXISTS "asset_draft_expiry_idx"',
          'DROP INDEX IF EXISTS "project_background_object_key_idx"',
          'DROP TABLE IF EXISTS "storage_cleanup"',
          'DROP TABLE IF EXISTS "data_migration"',
        ]) {
          await tx.execute(sql.raw(statement));
        }

        const statements = readFileSync(catchUpPath, "utf8").split(
          "--> statement-breakpoint",
        );
        // Twice: a fresh install already has all of it when this runs.
        for (let pass = 0; pass < 2; pass++) {
          for (const statement of statements) {
            await tx.execute(sql.raw(statement));
          }
        }

        const present = await tx.execute(
          sql.raw(`select
            to_regclass('public.data_migration') is not null as data_migration,
            to_regclass('public.storage_cleanup') is not null as storage_cleanup,
            to_regclass('public."asset_draft_expiry_idx"') is not null as asset_index,
            to_regclass('public."project_background_object_key_idx"') is not null as background_index,
            (select count(*)::int from pg_trigger
              where tgname in ('asset_storage_cleanup', 'project_storage_cleanup')) as triggers`),
        );
        expect(present.rows[0]).toEqual({
          data_migration: true,
          storage_cleanup: true,
          asset_index: true,
          background_index: true,
          triggers: 2,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
