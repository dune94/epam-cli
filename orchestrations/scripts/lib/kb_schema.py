#!/usr/bin/env python3
"""
kb_schema.py — the single source of truth for self-heal knowledge records.

WHY PYDANTIC, AND WHY HERE
--------------------------
Pillar 3 of the memory-drift design says: put the constraint into the SCHEMA, not
into the prompt. A rule injected as prose gets softened over a long run — the model
drifts past it. A rule expressed as a structural type cannot be drifted past,
because malformed instances do not exist.

This module is that structure. `Constraint.enforcement` is a DISCRIMINATED UNION
over exactly three compile targets, so a "constraint" that is only advice is not a
validation failure — it is unconstructable. That is the admission rule from pillar 3
enforced by the type system rather than by a check somebody can forget to call.

The same models serve two jobs, which is the point:
  1. ADMISSION — validate every write to the procedural store.
  2. LLM BOUNDING — `json-schema` emits the JSON Schema handed to the analyst, so
     the model's output space IS the enforcement space. It cannot propose a fix that
     has no mechanism, the way the current analyst can (and does: target=none on 77
     of 118 diagnoses, because none of its options patch anything).

TWO STORES, NEVER ONE (pillar 1)
--------------------------------
  Episode    — what happened. Append-only, immutable, chronological. Never read by
               an agent; it is evidence, not instruction.
  Constraint — the deduplicated rule synthesised from N episodes. Keyed, enforceable.

Flattening these together is what makes an agent mistake a transient error for a
permanent rule.

CLI
---
  kb_schema.py json-schema constraint   -> JSON Schema for the analyst prompt
  kb_schema.py validate-constraint      -> stdin JSON; exit 0 valid, 2 invalid + reason
  kb_schema.py validate-episode         -> same, for episodes
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ─── Enforcement: the three compile targets (pillar 3) ────────────────────────
# Adding a fourth kind is a deliberate act: it requires a matching compiler branch
# in constraint-compiler.js, and the compiler test enumerates these to prove every
# kind can actually be applied. A constraint with no mechanism cannot be expressed.

class GateEnforcement(BaseModel):
    """A deterministic check in the gate chain. Adjudicated by tsc/vitest, not a model."""
    model_config = ConfigDict(extra="forbid")
    kind: Literal["gate"]
    check: str = Field(min_length=1, description="id of a deterministic check to enable")


class ParamEnforcement(BaseModel):
    """A field in the agent invocation registry the agent physically cannot exceed."""
    model_config = ConfigDict(extra="forbid")
    kind: Literal["param"]
    name: str = Field(min_length=1, description="e.g. EPAM_MAX_ITERATIONS")
    value: str = Field(min_length=1)


class ToolScopeEnforcement(BaseModel):
    """Narrowed write paths / tool set for the agent."""
    model_config = ConfigDict(extra="forbid")
    kind: Literal["tool_scope"]
    allowed_write_paths: Optional[str] = None
    allowed_tools: Optional[str] = None

    @field_validator("allowed_tools")
    @classmethod
    def _at_least_one(cls, v, info):
        if not v and not info.data.get("allowed_write_paths"):
            raise ValueError("tool_scope needs allowed_write_paths or allowed_tools")
        return v


Enforcement = Annotated[
    Union[GateEnforcement, ParamEnforcement, ToolScopeEnforcement],
    Field(discriminator="kind"),
]


# ─── Scope and trigger: the deterministic lookup key (pillar 1) ───────────────

class Scope(BaseModel):
    """Who the rule binds. Deterministic key — no similarity search."""
    model_config = ConfigDict(extra="forbid")
    agent_role: Optional[str] = None
    global_: bool = Field(default=False, alias="global")

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @field_validator("agent_role")
    @classmethod
    def _role_or_global(cls, v):
        return v


class Trigger(BaseModel):
    """When the rule applies. `signature` is a stable failure id (e.g. TS2532)."""
    model_config = ConfigDict(extra="forbid")
    signature: str = Field(min_length=1)
    phase: Optional[str] = None


# ─── The two record types ────────────────────────────────────────────────────

class Episode(BaseModel):
    """EPISODIC: what happened. Immutable evidence, never instruction."""
    model_config = ConfigDict(extra="allow")   # tolerate extra telemetry fields
    id: str = Field(min_length=1)
    ts: str = Field(default_factory=_utc_now)
    story_id: Optional[str] = None
    agent_role: Optional[str] = None
    signature: Optional[str] = None
    diagnosis: Optional[str] = None
    phase: Optional[str] = None
    model: Optional[str] = None
    retry: Optional[int] = None


class Constraint(BaseModel):
    """PROCEDURAL: the deduplicated, enforceable rule."""
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9-]*$")
    scope: Scope
    trigger: Trigger
    enforcement: Enforcement
    reason: str = Field(min_length=1, max_length=300)
    origin_episodes: list[str] = Field(default_factory=list)

    created: str = Field(default_factory=_utc_now)
    last_fired: Optional[str] = None

    # Pillar 2: a rule that stops firing must be re-validated, not trusted forever.
    ttl_cycles: int = Field(default=20, ge=1)
    cycles_idle: int = Field(default=0, ge=0)
    status: Literal["active", "archived"] = "active"
    superseded_by: Optional[str] = None

    @field_validator("scope")
    @classmethod
    def _scope_binds_something(cls, v: Scope) -> Scope:
        if not v.agent_role and not v.global_:
            raise ValueError("scope must set agent_role or global")
        return v


def _emit(ok: bool, detail: str = "") -> int:
    print(json.dumps({"ok": ok, "detail": detail}))
    return 0 if ok else 2


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == "json-schema":
        which = argv[2] if len(argv) > 2 else "constraint"
        model = {"constraint": Constraint, "episode": Episode}.get(which)
        if model is None:
            return _emit(False, f"unknown model '{which}'")
        print(json.dumps(model.model_json_schema(), indent=2))
        return 0
    if cmd in ("validate-constraint", "validate-episode"):
        model = Constraint if cmd.endswith("constraint") else Episode
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except json.JSONDecodeError as e:
            return _emit(False, f"not JSON: {e}")
        try:
            model.model_validate(payload)
        except ValidationError as e:
            first = e.errors()[0]
            loc = ".".join(str(p) for p in first.get("loc", ()))
            return _emit(False, f"{loc}: {first.get('msg')}")
        return _emit(True)
    return _emit(False, f"unknown command '{cmd}'")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
