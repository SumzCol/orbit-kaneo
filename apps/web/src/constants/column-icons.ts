import {
  Archive,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Search,
} from "lucide-react";
import projectIcons from "./project-icons";

export const DEFAULT_COLUMN_ICON_NAMES = {
  "to-do": "Circle",
  "in-progress": "CircleDot",
  "in-review": "Search",
  done: "CheckCircle2",
  blocked: "CircleSlash",
  archived: "Archive",
  planned: "CircleDashed",
} as const;

const columnIcons = {
  ...projectIcons,
  Circle,
  CircleDot,
  CircleSlash,
  Search,
  CheckCircle2,
  CircleDashed,
  Archive,
};

export type ColumnIconName = keyof typeof columnIcons;

export default columnIcons;
