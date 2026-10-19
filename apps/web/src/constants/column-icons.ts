import {
  Archive,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Clock,
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
  planned: "Clock",
} as const;

const columnIcons = {
  ...projectIcons,
  Circle,
  CircleDot,
  CircleSlash,
  Search,
  CheckCircle2,
  CircleDashed,
  Clock,
  Archive,
};

export type ColumnIconName = keyof typeof columnIcons;

export default columnIcons;
