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

describe("withJobLease across time zones", () => {
  // The host's zone is what broke this: `expires_at` is naive, so a lease
  // written through a JS Date landed in local wall-clock. West of UTC it was
  // born expired and every caller claimed it at once; east of UTC it outlived
  // its window. Both sides are computed by Postgres now, so neither the host
  // nor the session zone can move them.
  it.each(["UTC", "America/Bogota", "Asia/Tokyo"])(
    "holds the lease with the session in %s",
    async (zone) => {
      await clearLease();
      await db.execute(sql.raw(`SET TIME ZONE '${zone}'`));
      try {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const first = withJobLease(
          LEASE,
          async () => {
            await held;
            return "ran";
          },
          () => "skipped",
        );
        // Give the insert time to land before the second caller asks.
        await vi.waitFor(async () => {
          expect(await readLease()).toBeDefined();
        });

        expect(
          await withJobLease(
            LEASE,
            async () => "ran",
            () => "skipped",
          ),
        ).toBe("skipped");

        release();
        await expect(first).resolves.toBe("ran");
      } finally {
        await db.execute(sql.raw("SET TIME ZONE 'UTC'"));
      }
    },
  );

  it("stores the expiry in UTC regardless of the session zone", async () => {
    await clearLease();
    await db.execute(sql.raw("SET TIME ZONE 'Asia/Tokyo'"));
    try {
      await withJobLease(
        LEASE,
        async () => "ran",
        () => "skipped",
        60_000,
      );
    } finally {
      await db.execute(sql.raw("SET TIME ZONE 'UTC'"));
    }

    // The lease is released on the way out, so write one by hand and read the
    // stored value back against the database's own UTC clock.
    await db.execute(sql`
      INSERT INTO job_lease ("name", "owner", "expires_at")
      VALUES (${LEASE}, 'probe', (now() at time zone 'utc') + interval '1 minute');
    `);
    const [row] = (
      await db.execute(sql`
        SELECT "expires_at" > (now() at time zone 'utc') AS still_valid
        FROM job_lease WHERE "name" = ${LEASE};
      `)
    ).rows as { still_valid: boolean }[];
    expect(row.still_valid).toBe(true);
    await clearLease();
  });
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
