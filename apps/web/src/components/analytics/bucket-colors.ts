import labelColors from "@/constants/label-colors";
import type { BreakdownGroupBy } from "@/fetchers/analytics/get-project-breakdown";
import { resolveLabelColor } from "@/lib/label-color";

// The workspace label palette, reused so a chart bar belongs to the same
// family of colour as the rest of the app rather than being a second opinion
// about colour.
const PALETTE = labelColors.map((entry) => entry.color);

const NEUTRAL = "var(--color-muted-foreground)";

// The board colours priority through `priorityColorsTaskCard` and
// `getPriorityIcon`: info, warning, warning at 85%, destructive, and muted for
// no-priority. A chart that invents its own would make the same task two
// different colours on two screens. Medium and high share a hue there, so they
// share one here too — faithful to the board, and the reason those two bars
// look alike.
const PRIORITY_COLORS: Record<string, string> = {
  "no-priority": NEUTRAL,
  low: "var(--color-info)",
  medium: "color-mix(in srgb, var(--color-warning) 85%, transparent)",
  high: "var(--color-warning)",
  urgent: "var(--color-destructive)",
};

// Position in the sorted list is not an identity: buckets are ordered by
// count, so keying colour to the index repaints someone the moment their task
// count changes. Hashing the key keeps a person, label or status the same
// colour across renders.
function stableIndex(key: string) {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % PALETTE.length;
}

function meaningfulColor(
  bucket: { key: string | null; color: string | null },
  groupBy: BreakdownGroupBy,
): string | null {
  // A stored colour is a choice someone made in the workspace, so it wins.
  // `resolveLabelColor` is what the rest of the app uses to turn one into
  // CSS: the values are palette names like `purple`, not colours.
  if (bucket.color) return resolveLabelColor(bucket.color);
  if (groupBy === "priority" && bucket.key) {
    return PRIORITY_COLORS[bucket.key] ?? null;
  }
  // The unset bucket is an absence, not a category, so it stays neutral
  // instead of taking a colour that implies one.
  if (bucket.key === null) return NEUTRAL;
  return null;
}

/**
 * A colour per bucket, in the order given. Colours that carry meaning — a
 * stored one, a priority, the unset bucket — are used as they are. The rest
 * fall back to the palette, and a fallback that would repeat a colour already
 * on the chart walks forward until it finds a free one: two bars in the same
 * colour read as the same thing.
 */
export function assignBucketColors(
  buckets: { key: string | null; color: string | null }[],
  groupBy: BreakdownGroupBy,
  statusColors?: Map<string, string>,
): string[] {
  const taken = new Set<string>();
  const assigned: (string | null)[] = buckets.map((bucket) => {
    // A status inherits the colour of the state it belongs to, so the chart
    // and the distribution bar above it say the same thing. That mapping
    // outranks a stored column colour, which is chosen for a board column
    // rather than for a chart.
    const byState =
      groupBy === "status" && bucket.key
        ? statusColors?.get(bucket.key)
        : undefined;
    const meaningful = byState ?? meaningfulColor(bucket, groupBy);
    if (meaningful) taken.add(meaningful);
    return meaningful;
  });

  return assigned.map((colour, index) => {
    if (colour) return colour;
    const key = buckets[index]?.key ?? "";
    const start = stableIndex(key);
    for (let step = 0; step < PALETTE.length; step += 1) {
      const candidate = PALETTE[(start + step) % PALETTE.length] as string;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
    // More buckets than the palette holds. Repeating beats leaving a bar
    // uncoloured, and by here the chart is long enough that adjacency has
    // stopped carrying the comparison anyway.
    return PALETTE[start] as string;
  });
}
