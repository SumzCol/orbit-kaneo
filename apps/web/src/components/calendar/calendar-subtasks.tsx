import { Fragment } from "react";

export default function CalendarSubtasks({
  id,
  subtasks,
}: {
  /** Lets the item's button reference the list in aria-describedby. */
  id?: string;
  subtasks?: readonly { id: string; title: string }[];
}) {
  if (!subtasks?.length) return null;

  return (
    <span
      id={id}
      className="flex w-full min-w-0 flex-col gap-1 border-t border-current/15 pt-1 text-xs font-normal"
    >
      {subtasks.map((task, index) => (
        <Fragment key={task.id}>
          {/* Separates the titles in the announced text. A flex container
              never renders whitespace-only text, so the layout is unchanged. */}
          {index > 0 && " "}
          <span className="truncate pl-2" title={task.title}>
            {task.title}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
