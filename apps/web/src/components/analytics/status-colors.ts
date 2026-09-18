export type StatusColumn = {
  slug: string;
  position: number;
  isFinal: boolean;
  /** Present on the API's columns; the colour rules do not read it. */
  name?: string;
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

// The second status in a stage gets a token of its own rather than a mix, so
// "later in the stage" reads as lighter on both grounds. Mixing toward
// transparent composited over the card instead, which made In Review darker
// than In Progress in dark mode and lighter in light: the same status
// appearing to move within the ramp depending on the theme.
const STATE_COLOR_ALT: Partial<Record<TaskState, string>> = {
  unstarted: "var(--state-unstarted-alt)",
  started: "var(--state-started-alt)",
};

// Lifecycle order, which is also the order the distribution bar reads in.
// Sorting by count instead put Archived second and Planned last, scattering
// the colour groups.
const STATE_ORDER: TaskState[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "archived",
];

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
function sibling(state: TaskState, index: number) {
  const base = STATE_COLOR[state];
  if (index === 0) return base;
  const alt = STATE_COLOR_ALT[state];
  if (index === 1 && alt) return alt;
  // A third status in one stage is possible with custom columns and has no
  // token of its own. Fading the alt keeps the hue and the direction.
  const from = alt ?? base;
  const strength = Math.max(100 - (index - 1) * 25, 45);
  return `color-mix(in srgb, ${from} ${strength}%, transparent)`;
}

/**
 * A colour for every status the chart might show, keyed by the status string.
 * Statuses in the same state share its colour; within a state they are ordered
 * by column position so the one earliest in the workflow keeps full weight.
 */
export function statusColorMap(
  columns: StatusColumn[],
  statuses: string[] = [],
): Map<string, string> {
  // `isFinal` is editable on every column, Blocked included. A project that
  // marks it final means it as a terminal state, and the summary counts those
  // tasks as completed; colouring them red anyway would put the chart at odds
  // with the bar. Red is only reserved while Blocked is still work in flight.
  const blocked = columns.find((column) => column.slug === BLOCKED_SLUG);
  const blockedIsExceptional = blocked ? !blocked.isFinal : true;

  const bySlug = new Map(columns.map((column) => [column.slug, column]));
  const byState = new Map<TaskState, string[]>();
  const place = (slug: string) => {
    if (blockedIsExceptional && slug === BLOCKED_SLUG) return;
    if (slug === "planned" || slug === "archived") return;
    const state = stateOfStatus(slug, columns);
    const group = byState.get(state) ?? [];
    if (!group.includes(slug)) group.push(slug);
    byState.set(state, group);
  };

  // Columns first, earliest in the workflow first, so the weight ordering
  // follows the board.
  for (const column of [...columns].sort((a, b) => a.position - b.position)) {
    place(column.slug);
  }

  // Then any status the column list cannot explain — one whose column was
  // removed, say. Sorted, because it has no position to order it by and the
  // arrival order is the count order, which moves.
  //
  // These join their state's group rather than taking its base colour: a
  // project with `in-progress` and an orphan both in started would otherwise
  // paint two different bars the same, and `assignBucketColors` treats a
  // colour from this map as deliberate and never probes past a collision.
  for (const status of [...statuses].sort()) {
    if (!bySlug.has(status)) place(status);
  }

  const colors = new Map<string, string>();
  for (const [state, group] of byState) {
    group.forEach((slug, index) => {
      colors.set(slug, sibling(state, index));
    });
  }

  if (blockedIsExceptional) {
    colors.set(BLOCKED_SLUG, "var(--state-blocked)");
  }
  // Neither is a column, so neither appears above. Both are real statuses a
  // task can hold, and the summary counts them as their own states.
  colors.set("planned", STATE_COLOR.backlog);
  colors.set("archived", STATE_COLOR.archived);

  return colors;
}

/**
 * Buckets in lifecycle order: by the state each status belongs to, then by
 * column position within it. Leaves the colour groups adjacent and puts the
 * muted archived bucket last, where the eye stops.
 */
export function sortStatusBuckets<T extends { key: string | null }>(
  buckets: T[],
  columns: StatusColumn[],
): T[] {
  const positionOf = (slug: string) =>
    columns.find((column) => column.slug === slug)?.position ??
    Number.MAX_SAFE_INTEGER;

  return [...buckets].sort((a, b) => {
    const stateA = STATE_ORDER.indexOf(stateOfStatus(a.key ?? "", columns));
    const stateB = STATE_ORDER.indexOf(stateOfStatus(b.key ?? "", columns));
    if (stateA !== stateB) return stateA - stateB;
    return positionOf(a.key ?? "") - positionOf(b.key ?? "");
  });
}

export { STATE_COLOR };
