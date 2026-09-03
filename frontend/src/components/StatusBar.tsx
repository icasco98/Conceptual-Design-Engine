/**
 * Whatever Python last said about this arrangement, along the foot of the
 * window. It lives here rather than in a scrolling panel because the one
 * message that must never be missed is the one saying the plan is wrong.
 *
 * One line at rest, whatever the count. A single bad move — turning the
 * entry off the hallway, say — can strand a dozen rooms at once, and a bar
 * that grew to fit them ate a third of the screen and pushed the drawing
 * out of the way. So: the worst message, a count, and the rest on request.
 */
import { useState } from "react";

import { IconTick, IconWarn } from "./icons";
import { useStore } from "../state/store";

type Problem = { key: string; severity: string; message: string };

export function StatusBar() {
  const issues = useStore((s) => s.issues);
  const accessProblems = useStore((s) => s.accessProblems);
  const stackingIssues = useStore((s) => s.stackingIssues);
  const [open, setOpen] = useState(false);

  const problems: Problem[] = [
    ...issues.map((i) => ({ key: i.code + i.message, severity: i.severity, message: i.message })),
    ...accessProblems.map((p) => ({ key: `access-${p.room_name}`, severity: "warning", message: p.message })),
    ...stackingIssues.map((i) => ({ key: `stack-${i.code}${i.message}`, severity: "warning", message: i.message })),
  ];
  // Errors first: if the plan is both broken and merely questionable, the
  // broken part is what should be on the line you can see.
  problems.sort((a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1));

  if (problems.length === 0) {
    return (
      <footer className="status">
        <span className="status-item ok">
          <IconTick /> Every room reachable, every size checked
        </span>
      </footer>
    );
  }

  const [first, ...rest] = problems;

  return (
    <footer className={`status${open ? " open" : ""}`}>
      <div className="status-line">
        <span className={`status-item ${first.severity}`}>
          <IconWarn /> {first.message}
        </span>
        {rest.length > 0 && (
          <button type="button" className="status-more" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide" : `${rest.length} more`}
          </button>
        )}
      </div>
      {open && (
        <ul className="status-list">
          {rest.map((p) => (
            <li key={p.key} className={`status-item ${p.severity}`}>
              <IconWarn /> {p.message}
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
}
