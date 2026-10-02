/**
 * Tells an open board that access to its project may have been given back.
 *
 * A board whose socket was closed with 4403 stops reconnecting for good, and
 * a grant arrives on the user socket rather than on the board's own, so it
 * needs a way across. Local to this tab: every tab gets its own copy of the
 * user message.
 *
 * A "grant" is the server saying so. A "probe" is a guess, sent when the user
 * socket reconnects and a grant may have been missed while it was down: the
 * board tries once, and goes back to stopped if the upgrade is refused.
 */
export type AccessSignal = "grant" | "probe";
type Listener = (signal: AccessSignal) => void;

const listeners = new Map<string, Set<Listener>>();

export function onProjectAccessGranted(
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

export function announceProjectAccessGranted(projectId: string) {
  for (const listener of [...(listeners.get(projectId) ?? [])]) {
    listener("grant");
  }
}

export function probeRevokedProjects() {
  for (const forProject of [...listeners.values()]) {
    for (const listener of [...forProject]) listener("probe");
  }
}
