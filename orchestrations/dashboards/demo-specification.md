The file specification.html is a locked template in the epam-cli project. You may ONLY change text/data within existing elements. You must NOT add, remove, or rearrange any HTML tags, CSS classes, or structural elements. If a section doesn't apply, leave the element empty — do not remove it. Regenerate the specification.html in the demo project. This is to be ignored outside of a demo project.

Layout (Top down, left to right):
1. Header / Navigation: Top title area ("EPAM CLI — Specification Diff") and 11-link standard nav. Includes Dash Sync build-info pill (bottom-right corner).
2. Stats Bar: Summary counters — total stories, approved count, needs_review count, total AC (acceptance criteria), and agent contribution totals (added/modified/flagged by speckit).
3. Story Cards Grid: Expandable cards for each story showing:
   - Story ID, title, phase badge, and coordinator review status (approved/needs_review).
   - Collapsed view: Quick stats (AC count, agent count, status badge).
   - Expanded detail panel with:
     a. Acceptance Criteria list: Full AC items with status indicators.
     b. Agent Contributions (Sequential Pipeline): Step 1 (openspec — Elaborate) and Step 2 (speckit — Review & Harden).
     c. Speckit collaboration details: Criteria added, criteria modified (original vs revised), criteria flagged for human attention.
     d. Coordinator notes and review status.
4. Auto-refresh: 10-second polling with data fingerprint to skip re-render when unchanged; preserves expanded panel state across refreshes.
