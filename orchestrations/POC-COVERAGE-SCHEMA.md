# POC Coverage Schema Design

Date: 2026-03-01
Story: `EPAM-051`

## Purpose

Define a structured metadata model for:

- POC test coverage per PRD story
- bug-to-origin story linkage
- report and dashboard interoperability
- future live quality dashboard rollups

The goal is to avoid free-text comments inside `prd.json` and instead establish fields that can be validated, queried, and rendered consistently.

## Design Principles

1. Do not overload `status` or `completed`
   `status` reflects delivery lifecycle. POC coverage must be separate.

2. Keep story-local metadata structured
   Every story should be self-describing without requiring the POC report to become the source of truth.

3. Support one-to-many bug linkage
   A bug can originate from multiple stories. The model must not assume a single source story.

4. Make dashboards a read-only consumer
   Dashboards should consume normalized PRD metadata, not invent their own sidecar state model.

5. Preserve backward compatibility
   Existing stories should remain valid when the new fields are absent.

## Proposed Story Fields

Add an optional `quality` block to each story.

Example:

```json
{
  "id": "EPAM-023",
  "title": "MVP Control Plane — CLI-First Phase Runner",
  "quality": {
    "pocCoverage": {
      "status": "passed",
      "testedAt": "2026-03-01",
      "badge": "POC-TESTED",
      "tester": "bjerome",
      "evidence": [
        "test-evidence/poc/phase-run-provider-auth-require-approval-pass.txt"
      ],
      "reportRefs": [
        "POC-TEST-REPORT.md",
        "POC-TEST-REPORT.html"
      ],
      "notes": "Validated through phase approve/run path against mock backend."
    },
    "defectLinks": [
      {
        "storyId": "EPAM-050",
        "relationship": "reported_by_poc"
      }
    ]
  }
}
```

### `quality.pocCoverage`

Optional object.

Fields:

- `status`
  Allowed values:
  - `passed`
  - `failed`
  - `partial`
  - `not_tested`
  - `blocked`

- `testedAt`
  ISO date or timestamp.

- `badge`
  Short display label.
  Recommended values:
  - `POC-TESTED`
  - `POC-PARTIAL`
  - `POC-BLOCKED`

- `tester`
  Human or system identity.

- `evidence`
  Array of repo-relative file paths to screenshots, transcripts, or logs.

- `reportRefs`
  Array of repo-relative files that summarize the test outcome.

- `notes`
  Short optional summary. Not a substitute for structured fields.

### `quality.defectLinks`

Optional array of links from a feature story to related defect stories.

Each element:

```json
{
  "storyId": "EPAM-050",
  "relationship": "reported_by_poc"
}
```

Allowed `relationship` values:

- `reported_by_poc`
- `blocked_by_bug`
- `validated_by_fix`

## Proposed Bug Story Fields

Bug stories should carry a separate origin block.

Example:

```json
{
  "id": "EPAM-050",
  "title": "Backlog Bug — Remove Misleading Provider Slot Warning at REPL Init",
  "quality": {
    "originStories": [
      {
        "storyId": "EPAM-025",
        "relationship": "runtime_regression_against"
      },
      {
        "storyId": "EPAM-026",
        "relationship": "runtime_regression_against"
      }
    ],
    "pocCoverage": {
      "status": "failed",
      "testedAt": "2026-03-01",
      "badge": "POC-FOUND",
      "tester": "bjerome",
      "evidence": [
        "test-evidence/poc/chat-repl-smoke-output.txt"
      ]
    }
  }
}
```

### `quality.originStories`

Optional array for backlog bugs, regressions, or review findings.

Each element:

```json
{
  "storyId": "EPAM-025",
  "relationship": "runtime_regression_against"
}
```

Allowed `relationship` values:

- `runtime_regression_against`
- `implementation_bug_in`
- `review_finding_against`
- `follow_on_from`

## Dashboard Rollup Model

Dashboards should derive a normalized rollup from story-local fields.

Example rollup shape:

```json
{
  "generatedAt": "2026-03-01T15:00:00Z",
  "summary": {
    "totalStories": 51,
    "pocPassed": 24,
    "pocPartial": 0,
    "pocFailed": 2,
    "pocBlocked": 0,
    "notTested": 25,
    "backlogBugsLinked": 2
  },
  "byPhase": [
    {
      "phaseId": "mvp_cli_control",
      "totalStories": 6,
      "pocPassed": 6,
      "openBugCount": 0
    },
    {
      "phaseId": "provider_auth",
      "totalStories": 6,
      "pocPassed": 0,
      "openBugCount": 0
    }
  ],
  "stories": [
    {
      "id": "EPAM-023",
      "title": "MVP Control Plane — CLI-First Phase Runner",
      "phaseId": "mvp_cli_control",
      "deliveryStatus": "completed",
      "pocStatus": "passed",
      "badge": "POC-TESTED",
      "evidenceCount": 1,
      "linkedBugCount": 0
    }
  ]
}
```

## Live Quality Dashboard Design

Target views:

1. Coverage Overview
   Shows total POC-tested stories, pass/fail/blocked counts, and backlog bug count.

2. Phase Coverage
   Heatmap or grouped table by phase showing:
   - stories delivered
   - stories POC-tested
   - stories with linked bugs
   - stories still missing evidence

3. Story Detail
   Per-story panel with:
   - title
   - phase
   - delivery status
   - POC badge
   - evidence links
   - linked bugs
   - approval state if applicable

4. Bug Traceability
   Backlog bugs with origin stories and unresolved/open counts.

5. Evidence Explorer
   Links to screenshots, transcripts, reports, and approval logs.

## Dashboard Data Contract

Dashboard should read from a generated normalized JSON file, not directly from the raw HTML report.

Recommended flow:

1. `prd.json` is source of truth
2. a generator script creates `orchestrations/logs/quality-summary.json`
3. dashboards consume `quality-summary.json`
4. markdown/html reports are presentation artifacts, not canonical state

## Migration Strategy

Phase 1:

- Add optional `quality` block support to schema validator
- Do not require any story changes yet

Phase 2:

- Backfill POC-tested stories from the current report into `quality.pocCoverage`
- Add `originStories` to backlog bugs such as `EPAM-049` and `EPAM-050`

Phase 3:

- Generate normalized `quality-summary.json`
- Add live dashboard view

## Validation Rules

Recommended validator checks:

- `quality.pocCoverage.status` must be one of the allowed enum values
- `quality.pocCoverage.evidence` entries must be strings
- `quality.originStories[*].storyId` must resolve to an existing story
- bug stories should not link to themselves
- `badge` is optional but, if present, must be a short string
- evidence paths should be repo-relative, not absolute

## Open Questions

1. Should POC coverage be tracked for review stories separately from implementation stories in dashboard summaries?
2. Should bug linkage support reverse materialization automatically, or remain explicit on both sides?
3. Should approval-backed phase evidence be attached to stories individually or only to phase-level review stories?

## Recommendation

Implement the schema as an optional `quality` block. It is the cleanest way to:

- preserve compatibility
- avoid comment-style metadata
- support dashboard rollups
- support bug traceability
- let the POC report and dashboards share a single data contract
