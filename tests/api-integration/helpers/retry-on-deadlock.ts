const DEADLOCK_DETECTED = "40P01";

// Drizzle wraps driver errors, so the Postgres code may sit on the cause.
function isDeadlock(error: unknown): boolean {
  for (let current = error; current instanceof Object;) {
    if ((current as { code?: unknown }).code === DEADLOCK_DETECTED) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs `run`, retrying with a short backoff when Postgres aborts it to break a
 * deadlock. Any other error, or a deadlock on the last attempt, is rethrown.
 */
export async function retryOnDeadlock<T>(
  run: () => Promise<T>,
  attempts = 5,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isDeadlock(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}
