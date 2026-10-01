import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import db from "../database";

const INSTANCE_ID = randomUUID();

export const SEAT_RECONCILIATION_LEASE = "seat-reconciliation";

const DEFAULT_LEASE_MS = 15 * 60 * 1000;

export async function withJobLease<T>(
  name: string,
  run: () => Promise<T>,
  whenHeldElsewhere: () => T,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<T> {
  // Both sides of the comparison are computed by Postgres, in UTC.
  //
  // `expires_at` is `timestamp without time zone`, and the driver serialises a
  // JS Date as local wall-clock, so on any instance not running in UTC the
  // lease was written in the past: west of UTC it was born already expired and
  // every caller claimed it at once, east of UTC it outlived its window. The
  // comparison had the matching flaw -- `now()` is a timestamptz, and
  // comparing it against a naive column resolves through the session's time
  // zone rather than the one the value was written in.
  const leaseSeconds = leaseMs / 1000;
  const claimed = await db.execute(sql`
    INSERT INTO job_lease ("name", "owner", "expires_at")
    VALUES (
      ${name},
      ${INSTANCE_ID},
      (now() at time zone 'utc') + make_interval(secs => ${leaseSeconds})
    )
    ON CONFLICT ("name") DO UPDATE
      SET "owner" = EXCLUDED."owner", "expires_at" = EXCLUDED."expires_at"
      WHERE job_lease."expires_at" < (now() at time zone 'utc')
    RETURNING "name";
  `);

  if ((claimed.rowCount ?? 0) === 0) {
    return whenHeldElsewhere();
  }

  try {
    return await run();
  } finally {
    await db
      .execute(
        sql`DELETE FROM job_lease WHERE "name" = ${name} AND "owner" = ${INSTANCE_ID};`,
      )
      .catch((error) => {
        console.error(`Failed to release the ${name} lease`, error);
      });
  }
}
