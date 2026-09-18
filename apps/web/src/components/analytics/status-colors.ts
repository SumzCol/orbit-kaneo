export type StatusColumn = {
  slug: string;
  position: number;
  isFinal: boolean;
};

export type TaskState =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "archived";

const STATE_COLOR: Record<TaskState, string> = {
  backlog: "var(--state-backlog)",
  unstarted: "var(--state-unstarted)",
  started: "var(--state-started)",
  completed: "var(--state-completed)",
  archived: "var(--state-archived)",
};

// Blocked is not a sixth state — it is a started column, and the summary counts
// it as one. It takes the exceptional colour anyway, because it is the only
// status on the board that asks somebody to do something. Matched by the
// seeded slug, like `to-do` is: a column renamed in project settings keeps its
// slug, one created from scratch under another name will not match.
const BLOCKED_SLUG = "blocked";

// The same rule the summary endpoint applies, so the chart and the bar above
// it cannot disagree: no column means backlog or archived, a final column is
// completed, `to-do` is unstarted, anything else is started.
export function stateOfStatus(
  status: string,
  columns: StatusColumn[],
): TaskState {
  if (status === "planned") return "backlog";
  if (status === "archived") return "archived";
  const column = columns.find((candidate) => candidate.slug === status);
  if (!column) return "started";
  if (column.isFinal) return "completed";
  return column.slug === "to-do" ? "unstarted" : "started";
}

// Siblings within a state share its hue and separate by weight. Mixing toward
// transparent rather than toward a literal keeps that working on both grounds:
// over a dark card it reads darker, over a light one lighter, and in each case
// as the same colour carrying less weight.
function sibling(color: string, index: number) {
  if (index === 0) return color;
  const strength = Math.max(100 - index * 30, 40);
  return `color-mix(in srgb, ${color} ${strength}%, transparent)`;
}

/**
 * A colour for every status the chart might show, keyed by the status string.
 * Statuses in the same state share its colour; within a state they are ordered
 * by column position so the one earliest in the workflow keeps full weight.
 */
export function statusColorMap(columns: StatusColumn[]): Map<string, string> {
  const byState = new Map<TaskState, StatusColumn[]>();

  for (const column of columns) {
    if (column.slug === BLOCKED_SLUG) continue;
    const state = stateOfStatus(column.slug, columns);
    const bucket = byState.get(state) ?? [];
    bucket.push(column);
    byState.set(state, bucket);
  }

  const colors = new Map<string, string>();

  for (const [state, group] of byState) {
    const ordered = [...group].sort((a, b) => a.position - b.position);
    ordered.forEach((column, index) => {
      colors.set(column.slug, sibling(STATE_COLOR[state], index));
    });
  }

  colors.set(BLOCKED_SLUG, "var(--state-blocked)");
  // Neither is a column, so neither appears above. Both are real statuses a
  // task can hold, and the summary counts them as their own states.
  colors.set("planned", STATE_COLOR.backlog);
  colors.set("archived", STATE_COLOR.archived);

  return colors;
}

export { STATE_COLOR };
