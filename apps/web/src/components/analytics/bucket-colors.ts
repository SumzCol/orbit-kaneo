import labelColors from "@/constants/label-colors";
import type { BreakdownGroupBy } from "@/fetchers/analytics/get-project-breakdown";
import { resolveLabelColor } from "@/lib/label-color";

// The workspace label palette, reused so a chart bar belongs to the same
// family of colour as the rest of the app rather than being a second opinion
// about colour.
const PALETTE = labelColors.map((entry) => entry.color);

// The board colours priority through `priorityColorsTaskCard`: info, warning,
// warning at 85%, destructive. A chart that invents its own would make the
// same task two different colours on two screens. Medium and high share a hue
// there, so they share one here too — faithful to the board, and the reason
// those two bars look alike.
const PRIORITY_COLORS: Record<string, string> = {
  low: "var(--color-info)",
  medium: "color-mix(in srgb, var(--color-warning) 85%, transparent)",
  high: "var(--color-warning)",
  urgent: "var(--color-destructive)",
};

// Position in the sorted list is not an identity: buckets are ordered by
// count, so keying colour to the index repaints someone the moment their
// task count changes. Hashing the key keeps a person, label or status the
// same colour across every render and every grouping.
function stableIndex(key: string, buckets: number) {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % buckets;
}

export function bucketColor(
  bucket: { key: string | null; color: string | null },
  groupBy: BreakdownGroupBy,
): string {
  // A stored colour is a choice someone made in the workspace, so it wins.
  // `resolveLabelColor` is what the rest of the app uses to turn one into
  // CSS: the values are palette names like `purple`, not colours.
  if (bucket.color) return resolveLabelColor(bucket.color);

  if (groupBy === "priority" && bucket.key) {
    const known = PRIORITY_COLORS[bucket.key];
    if (known) return known;
  }

  // The unset bucket is an absence, not a category, so it stays neutral
  // instead of taking a colour that implies one.
  if (bucket.key === null) return "var(--color-muted-foreground)";

  return PALETTE[stableIndex(bucket.key, PALETTE.length)] as string;
}
