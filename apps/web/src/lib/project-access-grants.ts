/**
 * Tells an open board that access to its project was given back.
 *
 * A board whose socket was closed with 4403 stops reconnecting for good, and
 * the grant arrives on the user socket rather than on the board's own, so it
 * needs a way across. Local to this tab: every tab gets its own copy of the
 * user message.
 */
type Listener = () => void;

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
    listener();
  }
}
