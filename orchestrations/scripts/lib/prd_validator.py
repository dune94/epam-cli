#!/usr/bin/env python3
"""
PRD Schema Validator
Validates prd.json structure, referential integrity, and schema constraints.
"""

import json
import sys
import argparse
from typing import Dict, List, Set, Tuple, Any


# Schema constraints
REQUIRED_FIELDS = [
    'id', 'title', 'description', 'priority', 'status', 'completed',
    'agentGroup', 'agentRole', 'storyType', 'estimatedHours',
    'dependencies', 'acceptanceCriteria'
]

OPTIONAL_FIELDS_FOR_WARNINGS = ['humanHours', 'effort', 'cpaGate']

VALID_PRIORITIES = {'low', 'medium', 'high', 'critical'}
VALID_STORY_TYPES = {'implementation', 'review', 'health_check'}
VALID_EFFORTS = {'low', 'medium', 'high'}


class Violation:
    """Represents a validation violation."""

    def __init__(self, story_id: str, field: str, message: str, is_warning: bool = False):
        self.story_id = story_id
        self.field = field
        self.message = message
        self.is_warning = is_warning

    def __str__(self) -> str:
        prefix = "WARNING" if self.is_warning else "ERROR"
        if self.story_id:
            return f"{prefix}: {self.story_id}: {self.message}"
        else:
            return f"{prefix}: {self.message}"

    def to_dict(self) -> Dict[str, Any]:
        return {
            'type': 'warning' if self.is_warning else 'error',
            'storyId': self.story_id,
            'field': self.field,
            'message': self.message
        }


class PRDValidator:
    """Validates PRD JSON structure and constraints."""

    def __init__(self, prd_data: Dict, strict: bool = False, phase_filter: str = None):
        self.prd = prd_data
        self.strict = strict
        self.phase_filter = phase_filter
        self.violations: List[Violation] = []
        self.stories = prd_data.get('stories', [])
        self.implementation_order = prd_data.get('implementationOrder', {})

    def validate(self) -> Tuple[int, int]:
        """
        Run all validations.
        Returns: (error_count, warning_count)
        """
        # Get story IDs to validate based on phase filter
        story_ids_to_validate = self._get_story_ids_to_validate()

        # Build set of all story IDs for referential checks
        all_story_ids = {story['id'] for story in self.stories if 'id' in story}

        # Validate each story
        for story in self.stories:
            story_id = story.get('id', '<missing-id>')

            # Skip if phase filter active and story not in scope
            if self.phase_filter and story_id not in story_ids_to_validate:
                continue

            self._validate_story_fields(story, story_id)
            self._validate_enums(story, story_id)
            self._validate_dependencies(story, story_id, all_story_ids)

        # Global validations (only if no phase filter)
        if not self.phase_filter:
            self._validate_duplicate_ids()
            self._validate_implementation_order(all_story_ids)
            self._validate_orphaned_stories(all_story_ids)

        # Count errors and warnings
        errors = [v for v in self.violations if not v.is_warning]
        warnings = [v for v in self.violations if v.is_warning]

        return len(errors), len(warnings)

    def _get_story_ids_to_validate(self) -> Set[str]:
        """Get story IDs in the filtered phase, if any."""
        if not self.phase_filter:
            return set()

        phase_stories = self.implementation_order.get(self.phase_filter, [])
        return set(phase_stories)

    def _validate_story_fields(self, story: Dict, story_id: str):
        """Validate required and optional fields on a story."""
        # Required fields
        for field in REQUIRED_FIELDS:
            if field not in story:
                self.violations.append(
                    Violation(story_id, field, f"missing field '{field}'")
                )

        # Optional fields (warnings in strict mode)
        if self.strict:
            for field in OPTIONAL_FIELDS_FOR_WARNINGS:
                if field not in story:
                    self.violations.append(
                        Violation(story_id, field, f"missing optional field '{field}'", is_warning=True)
                    )

    def _validate_enums(self, story: Dict, story_id: str):
        """Validate enum field constraints."""
        # Priority
        if 'priority' in story:
            priority = story['priority']
            if priority not in VALID_PRIORITIES:
                self.violations.append(
                    Violation(story_id, 'priority',
                             f"invalid priority '{priority}', must be one of {VALID_PRIORITIES}")
                )

        # Story type
        if 'storyType' in story:
            story_type = story['storyType']
            if story_type not in VALID_STORY_TYPES:
                self.violations.append(
                    Violation(story_id, 'storyType',
                             f"invalid storyType '{story_type}', must be one of {VALID_STORY_TYPES}")
                )

        # Effort (optional field)
        if 'effort' in story:
            effort = story['effort']
            if effort not in VALID_EFFORTS:
                self.violations.append(
                    Violation(story_id, 'effort',
                             f"invalid effort '{effort}', must be one of {VALID_EFFORTS}")
                )

    def _validate_dependencies(self, story: Dict, story_id: str, all_story_ids: Set[str]):
        """Validate dependency referential integrity."""
        dependencies = story.get('dependencies', [])

        for dep_id in dependencies:
            if dep_id not in all_story_ids:
                self.violations.append(
                    Violation(story_id, 'dependencies',
                             f"dependency '{dep_id}' not found")
                )

    def _validate_duplicate_ids(self):
        """Check for duplicate story IDs."""
        seen_ids = set()

        for story in self.stories:
            story_id = story.get('id')
            if not story_id:
                continue

            if story_id in seen_ids:
                self.violations.append(
                    Violation(story_id, 'id', f"duplicate id: '{story_id}'")
                )
            else:
                seen_ids.add(story_id)

    def _validate_implementation_order(self, all_story_ids: Set[str]):
        """Validate implementationOrder referential integrity."""
        for phase_name, story_ids in self.implementation_order.items():
            for story_id in story_ids:
                if story_id not in all_story_ids:
                    self.violations.append(
                        Violation('', 'implementationOrder',
                                 f"phase '{phase_name}': story ID '{story_id}' not found in stories")
                    )

    def _validate_orphaned_stories(self, all_story_ids: Set[str]):
        """Validate that every story appears in exactly one phase."""
        # Build map of story_id -> list of phases it appears in
        story_phases = {story_id: [] for story_id in all_story_ids}

        for phase_name, story_ids in self.implementation_order.items():
            for story_id in story_ids:
                if story_id in story_phases:
                    story_phases[story_id].append(phase_name)

        # Check for orphans and duplicates
        for story_id, phases in story_phases.items():
            if len(phases) == 0:
                self.violations.append(
                    Violation(story_id, 'implementationOrder',
                             f"orphaned story: not in any phase")
                )
            elif len(phases) > 1:
                self.violations.append(
                    Violation(story_id, 'implementationOrder',
                             f"appears in multiple phases: {phases}")
                )

    def get_violations(self) -> List[Violation]:
        """Return all violations."""
        return self.violations


def main():
    parser = argparse.ArgumentParser(
        description='Validate PRD JSON schema and referential integrity'
    )
    parser.add_argument('prd_file', help='Path to prd.json file')
    parser.add_argument('--strict', action='store_true',
                       help='Treat warnings as errors')
    parser.add_argument('--phase', metavar='ID',
                       help='Validate only stories in the specified phase')
    parser.add_argument('--json', action='store_true',
                       help='Output violations as JSON')

    args = parser.parse_args()

    # Load PRD file
    try:
        with open(args.prd_file, 'r') as f:
            prd_data = json.load(f)
    except FileNotFoundError:
        print(f"ERROR: File not found: {args.prd_file}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in {args.prd_file}: {e}", file=sys.stderr)
        sys.exit(1)

    # Validate
    validator = PRDValidator(prd_data, strict=args.strict, phase_filter=args.phase)
    error_count, warning_count = validator.validate()
    violations = validator.get_violations()

    # Output results
    if args.json:
        # JSON output
        output = [v.to_dict() for v in violations]
        print(json.dumps(output, indent=2))
    else:
        # Human-readable output
        for violation in violations:
            print(violation)

        # Summary
        story_count = len(prd_data.get('stories', []))
        if args.phase:
            phase_stories = prd_data.get('implementationOrder', {}).get(args.phase, [])
            story_count = len(phase_stories)
            print(f"\n{story_count} stories in phase '{args.phase}' validated, {error_count} errors, {warning_count} warnings")
        else:
            print(f"\n{story_count} stories validated, {error_count} errors, {warning_count} warnings")

    # Exit code
    if error_count > 0:
        sys.exit(1)
    elif args.strict and warning_count > 0:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == '__main__':
    main()
