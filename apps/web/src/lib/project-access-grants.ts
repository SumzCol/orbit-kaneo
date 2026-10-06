/**
 * Carries access changes from the user socket to an open board's own.
 *
 * Access changes arrive on the user socket, not on the board's, and a board's
 * socket may be closed, between retries or polling when they do, so it needs
 * a way across. Local to this tab: every tab gets its own copy of the user
 * message.
 *
 * - "grant": the server says access was given. A board stopped by 4403 tries
 *   to reconnect.
 * - "revoke": the server says access ended. A board with no open socket to
 *   receive the 4403 stops retrying and polling, as if it had.
 * - "probe": a guess, sent when the user socket reconnects and either kind of
 *   message may have been missed while it was down. A board that is stopped
 *   or not connected tries once; a refused attempt drops its caches.
 */
export type AccessSignal = "grant" | "revoke" | "probe";
type Listener = (signal: AccessSignal) => void;

const listeners = new Map<string, Set<Listener>>();

export function onProjectAccessSignal(
  projectId: string,
  listener: Listener,
): () => void {
  let forProject = listeners.get(projectId);
  if (!forProject) {
    forProject = new Set();
    listeners.set(projectId, forProject);
  }
  forProject.add(listener);

  return () => {
    forProject.delete(listener);
    if (forProject.size === 0) listeners.delete(projectId);
  };
}

function signal(projectId: string, kind: AccessSignal) {
  for (const listener of [...(listeners.get(projectId) ?? [])]) {
    listener(kind);
  }
}

export function announceProjectAccessGranted(projectId: string) {
  signal(projectId, "grant");
}

export function announceProjectAccessLost(projectId: string) {
  signal(projectId, "revoke");
}

export function probeProjectBoards() {
  for (const projectId of [...listeners.keys()]) signal(projectId, "probe");
}
