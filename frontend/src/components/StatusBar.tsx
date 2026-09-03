/** Whatever Python last said about this arrangement, along the foot of the
 *  window. It lives here rather than in a scrolling panel because the one
 *  message that must never be missed is the one saying the plan is wrong. */
import { IconTick, IconWarn } from "./icons";
import { useStore } from "../state/store";

export function StatusBar() {
  const issues = useStore((s) => s.issues);
  const accessProblems = useStore((s) => s.accessProblems);
  const stackingIssues = useStore((s) => s.stackingIssues);

  const problems = [
    ...issues.map((i) => ({ key: i.code + i.message, severity: i.severity, message: i.message })),
    ...accessProblems.map((p) => ({ key: `access-${p.room_name}`, severity: "warning", message: p.message })),
    ...stackingIssues.map((i) => ({ key: `stack-${i.code}${i.message}`, severity: "warning", message: i.message })),
  ];

  return (
    <footer className="status">
      {problems.length === 0 ? (
        <span className="status-item ok">
          <IconTick /> Every room reachable, every size checked
        </span>
      ) : (
        problems.map((p) => (
          <span key={p.key} className={`status-item ${p.severity}`}>
            <IconWarn /> {p.message}
          </span>
        ))
      )}
    </footer>
  );
}
