The file quality-assurance.html is a locked template in the epam-cli project. You may ONLY change text/data within existing elements. You must NOT add, remove, or rearrange any HTML tags, CSS classes, or structural elements. If a section doesn't apply, leave the element empty — do not remove it. Regenerate the quality-assurance.html in the demo project. This is to be ignored outside of a demo project.

Layout (Top down, left to right):
1. Header / Navigation: Sticky EPAM gradient header with page identity ("QA Gates") and 11-link nav to other dashboards. Includes Dash Sync build-info pill (bottom-right corner).
2. Stats Bar: Top KPI counters (gate runs, passed, failed, phases tested, avg duration, last run timestamp).
3. Filter Controls: Verdict filter buttons (ALL, PASS, FAIL, WARN) plus refresh/expand controls.
4. Phase Sections: Collapsible phase blocks (one per orchestration phase that has gate data).
5. Agent Cards: Per-agent result rows within each phase showing agent name, gate phase badge (A/B/C), step number, and verdict badge.
6. Agent Detail Panels: Expandable detail area for each agent showing summary table (agent, gate phase, exit code, verdict, log file link) and agent role description.
7. Data Source: Reads testing-gates.jsonl (JSONL) from orchestrations/logs/. Each line is a gate run with phase_id, agent exit codes, verdict, and duration.
8. Auto-refresh: 15-second polling with entry count comparison to skip re-render when unchanged.
