import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import db from "../../apps/api/src/database";
import { withJobLease } from "../../apps/api/src/scheduler/leader-lock";
import { ensureTestDatabaseMigrated } from "./helpers/database";

const LEASE = "integration-test-lease";

async function clearLease() {
  await db.execute(sql`DELETE FROM job_lease WHERE "name" = ${LEASE};`);
}

async function readLease() {
  const rows = await db.execute(
    sql`SELECT "owner", "expires_at" FROM job_lease WHERE "name" = ${LEASE};`,
  );
  return rows.rows[0];
}

beforeAll(async () => {
  await ensureTestDatabaseMigrated();
});

// Seconds until the stored expiry, against the database's own UTC clock.
async function secondsUntilExpiry() {
  const [row] = (
    await db.execute(sql`
      SELECT extract(epoch from "expires_at" - (now() at time zone 'utc'))::float
        AS seconds
      FROM job_lease WHERE "name" = ${LEASE};
    `)
  ).rows as { seconds: number }[];
  return row?.seconds;
}

describe("withJobLease across time zones", () => {
  // The process's zone is what broke this: `expires_at` is naive, and the
  // driver serialises a JS Date as local wall-clock, so a lease written by a
  // process west of UTC was born expired and every caller claimed it at once,
  // and one east of UTC outlived its window. Node applies a change to
  // process.env.TZ immediately, so each case really runs in that zone,
  // whichever pooled connection the queries use.
  //
  // The session's zone needs no case of its own: both sides of the
  // comparison come from `now() at time zone 'utc'`, which it cannot move.
  it.each(["UTC", "America/Bogota", "Asia/Tokyo"])(
    "holds the lease for its window with the process in %s",
    async (zone) => {
      await clearLease();
      const previousZone = process.env.TZ;
      process.env.TZ = zone;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding = false;
      const first = withJobLease(
        LEASE,
        async () => {
          holding = true;
          await held;
          return "ran";
        },
        () => "skipped",
        60_000,
      );
      try {
        await vi.waitFor(() => {
          expect(holding).toBe(true);
        });

        // The live row, as withJobLease wrote it, about a minute ahead.
        const seconds = await secondsUntilExpiry();
        expect(seconds).toBeGreaterThan(50);
        expect(seconds).toBeLessThanOrEqual(60);

        expect(
          await withJobLease(
            LEASE,
            async () => "ran",
            () => "skipped",
          ),
        ).toBe("skipped");
      } finally {
        release();
        await first;
        if (previousZone === undefined) delete process.env.TZ;
        else process.env.TZ = previousZone;
      }
    },
  );
});

describe("withJobLease", () => {
  it("lets a second caller skip while the first still holds the lease", async () => {
    await clearLease();

    let firstHasLease = false;
    let secondRan = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withJobLease(
      LEASE,
      async () => {
        firstHasLease = true;
        await held;
        return "ran";
      },
      () => "skipped",
    );

    try {
      await vi.waitFor(() => {
        expect(firstHasLease).toBe(true);
      });

      const second = await withJobLease(
        LEASE,
        async () => {
          secondRan = true;
          return "ran";
        },
        () => "skipped",
      );

      expect(second).toBe("skipped");
      expect(secondRan).toBe(false);
    } finally {
      release();
      await expect(first).resolves.toBe("ran");
    }
  });

  it("releases the lease so a later run can take it", async () => {
    await clearLease();

    const first = await withJobLease(
      LEASE,
      async () => "ran",
      () => "skipped",
    );
    const second = await withJobLease(
      LEASE,
      async () => "ran",
      () => "skipped",
    );

    expect(first).toBe("ran");
    expect(second).toBe("ran");
    expect(await readLease()).toBeUndefined();
  });

  it("releases the lease when the job throws", async () => {
    await clearLease();

    await expect(
      withJobLease(
        LEASE,
        async () => {
          throw new Error("job blew up");
        },
        () => "skipped",
      ),
    ).rejects.toThrow("job blew up");

    expect(await readLease()).toBeUndefined();

    const after = await withJobLease(
      LEASE,
      async () => "ran",
      () => "skipped",
    );
    expect(after).toBe("ran");
  });

  it("takes over a lease left behind by a crashed replica", async () => {
    await clearLease();

    await db.execute(sql`
      INSERT INTO job_lease ("name", "owner", "expires_at")
      VALUES (${LEASE}, 'dead-replica', now() - interval '1 minute');
    `);

    const result = await withJobLease(
      LEASE,
      async () => "ran",
      () => "skipped",
    );

    expect(result).toBe("ran");
  });

  it("does not take over a lease that is still live", async () => {
    await clearLease();

    await db.execute(sql`
      INSERT INTO job_lease ("name", "owner", "expires_at")
      VALUES (${LEASE}, 'other-replica', now() + interval '10 minutes');
    `);

    const result = await withJobLease(
      LEASE,
      async () => "ran",
      () => "skipped",
    );

    expect(result).toBe("skipped");
    expect((await readLease())?.owner).toBe("other-replica");

    await clearLease();
  });

  it("does not block a different lease name", async () => {
    await clearLease();

    let holderHasLease = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = withJobLease(
      LEASE,
      async () => {
        holderHasLease = true;
        await held;
        return "ran";
      },
      () => "skipped",
    );

    try {
      await vi.waitFor(() => {
        expect(holderHasLease).toBe(true);
      });

      const other = await withJobLease(
        `${LEASE}-other`,
        async () => "ran",
        () => "skipped",
      );

      expect(other).toBe("ran");
    } finally {
      release();
      await holder;
    }
  });
});
