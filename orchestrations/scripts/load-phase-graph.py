#!/usr/bin/env python3
"""
load-phase-graph.py - Import orchestration phase data into Neo4j via Bolt
EPAM CLI orchestration graph importer

Reads: prd.json, phase-cost.jsonl, phase-gates.jsonl, agent-messages.jsonl
Writes: Neo4j graph (Bolt protocol -- works with local Docker and AuraDB)

Usage:
  python3 load-phase-graph.py
  python3 load-phase-graph.py --phase phase_cost_test_1
  python3 load-phase-graph.py --clear
"""

import json, os, sys, argparse
from pathlib import Path
from datetime import datetime

try:
    from neo4j import GraphDatabase
except ImportError:
    print("ERROR: neo4j driver not installed. Run: pip3 install neo4j", file=sys.stderr)
    sys.exit(1)

# -- Config from environment --
SCRIPT_DIR    = Path(__file__).parent.resolve()
AUTOMATION    = SCRIPT_DIR.parent
PROJECT_ROOT  = AUTOMATION.parent

def load_env():
    """Load NEO4J_* vars from .env if not already in environment."""
    env_file = PROJECT_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("NEO4J_") and "=" in line and not line.startswith("#"):
                key, _, val = line.partition("=")
                val = val.strip().strip("'\"")
                if key not in os.environ:
                    os.environ[key] = val

load_env()

BOLT_URL  = os.environ.get("NEO4J_BOLT", "neo4j://localhost:7687")
NEO4J_URL = os.environ.get("NEO4J_URL",  "http://localhost:7474")
USER      = os.environ.get("NEO4J_USER",     "neo4j")
PASSWORD  = os.environ.get("NEO4J_PASSWORD", "")
DB        = os.environ.get("NEO4J_DB",       "neo4j")
LOG_DIR   = Path(os.environ.get("LOG_DIR", str(AUTOMATION / "logs")))
PRD_FILE  = Path(os.environ.get("PRD_FILE", str(AUTOMATION / "prd.json")))
PROFILES  = AUTOMATION / "agents" / "profiles.json"

if not PASSWORD:
    print("ERROR: NEO4J_PASSWORD not set. Add it to .env or export it.", file=sys.stderr)
    sys.exit(1)

# -- CLI args --
parser = argparse.ArgumentParser()
parser.add_argument("--phase", default="", help="Filter to specific phase ID")
parser.add_argument("--clear", action="store_true", help="Clear graph before import")
args = parser.parse_args()

PHASE_FILTER = args.phase

# -- Helpers --
def log(msg):   print(f"\033[0;34m[{datetime.now().strftime('%H:%M:%S')}]\033[0m {msg}")
def ok(msg):    print(f"\033[0;32m[OK]\033[0m {msg}")
def warn(msg):  print(f"\033[1;33m[WARN]\033[0m {msg}", file=sys.stderr)
def error(msg): print(f"\033[0;31m[ERROR]\033[0m {msg}", file=sys.stderr)

def parse_jsonl_multiobj(path):
    """Parse a file that may contain multiple concatenated JSON objects (not strict JSONL)."""
    content = Path(path).read_text()
    decoder = json.JSONDecoder()
    pos, objs = 0, []
    while pos < len(content):
        stripped = content[pos:].lstrip()
        if not stripped:
            break
        try:
            obj, end = decoder.raw_decode(stripped)
            objs.append(obj)
            pos += len(content[pos:]) - len(stripped) + end
        except json.JSONDecodeError:
            break
    return objs

def safe(s):
    """Escape single quotes for Cypher strings."""
    return str(s).replace("'", "\\'") if s else ""

# -- Connect --
log(f"Connecting to Neo4j at {BOLT_URL}...")
try:
    driver = GraphDatabase.driver(BOLT_URL, auth=(USER, PASSWORD))
    driver.verify_connectivity()
    ok("Connected")
except Exception as e:
    error(f"Connection failed: {e}")
    sys.exit(1)

def run(session, cypher, **params):
    try:
        session.run(cypher, **params)
    except Exception as e:
        warn(f"Cypher error: {e}\n  Statement: {cypher[:120]}")

# -- Main import --
with driver.session(database=DB) as s:

    # Clear
    if args.clear:
        log("Clearing existing graph data...")
        s.run("MATCH (n) CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS")
        ok("Graph cleared")

    # Constraints
    log("Setting up constraints...")
    for label, prop in [("Phase","id"),("Story","id"),("Agent","id"),
                        ("Lane","id"),("GateDecision","id"),("Message","id")]:
        try:
            s.run(f"CREATE CONSTRAINT {label.lower()}_{prop}_unique IF NOT EXISTS "
                  f"FOR (n:{label}) REQUIRE n.{prop} IS UNIQUE")
        except Exception:
            pass  # May already exist
    ok("Constraints ready")

    # Lanes
    log("Creating lanes...")
    for lane_id, name, color in [
        ("main",        "Main Sequential",      "#4CAF50"),
        ("primary",     "Primary Parallel",     "#2196F3"),
        ("independent", "Independent Parallel", "#9C27B0"),
    ]:
        s.run("MERGE (l:Lane {id:$id}) SET l.name=$name, l.color=$color",
              id=lane_id, name=name, color=color)

    # Agents from profiles.json
    if PROFILES.exists():
        log("Importing agents...")
        profiles = json.loads(PROFILES.read_text())
        for agent_id in profiles:
            s.run("MERGE (a:Agent {id:$id}) ON CREATE SET a.name=$id, a.createdAt=datetime()",
                  id=agent_id)
        ok(f"Imported {len(profiles)} agents")

    # Phases + Stories from prd.json
    if PRD_FILE.exists():
        log("Importing phases and stories from prd.json...")
        prd = json.loads(PRD_FILE.read_text())
        impl_order = prd.get("implementationOrder", {})

        # Build story->phase lookup
        story_phase = {}
        for phase_id, story_ids in impl_order.items():
            for sid in story_ids:
                story_phase[sid] = phase_id

        # Phase nodes
        for phase_id in impl_order:
            if PHASE_FILTER and phase_id != PHASE_FILTER:
                continue
            s.run("MERGE (p:Phase {id:$id}) ON CREATE SET p.name=$id, p.createdAt=datetime()",
                  id=phase_id)

        # Story nodes
        for story in prd.get("stories", []):
            sid       = story.get("id", "")
            phase_id  = story_phase.get(sid, "unassigned")
            if PHASE_FILTER and phase_id != PHASE_FILTER:
                continue
            if phase_id != "unassigned":
                s.run("MERGE (p:Phase {id:$id}) ON CREATE SET p.name=$id", id=phase_id)
            s.run(
                "MERGE (st:Story {id:$id}) SET "
                "st.title=$title, st.status=$status, st.completed=$completed, "
                "st.effort=$effort, st.lane=$lane, st.phaseId=$phaseId",
                id=sid, title=story.get("title",""), status=story.get("status","pending"),
                completed=bool(story.get("completed", False)),
                effort=story.get("effort","medium"),
                lane=story.get("agentGroup","main"), phaseId=phase_id
            )
            if phase_id != "unassigned":
                s.run("MATCH (p:Phase {id:$pid}),(st:Story {id:$sid}) MERGE (p)-[:HAS_STORY]->(st)",
                      pid=phase_id, sid=sid)
            lane_id = story.get("agentGroup","main")
            s.run("MATCH (l:Lane {id:$lid}),(st:Story {id:$sid}) MERGE (l)-[:CONTAINS]->(st)",
                  lid=lane_id, sid=sid)
        ok("Imported phases and stories")

    # phase-cost.jsonl -- execution data
    cost_log = LOG_DIR / "phase-cost.jsonl"
    if cost_log.exists() and cost_log.stat().st_size > 0:
        log("Importing execution data from phase-cost.jsonl...")
        count = 0
        for line in cost_log.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            phase_id = e.get("phase_id", "unknown")
            if PHASE_FILTER and phase_id != PHASE_FILTER:
                continue
            sid      = e.get("story_id", "")
            agent_id = e.get("agent_id") or e.get("agent_name", "unknown")
            s.run("MERGE (p:Phase {id:$id}) ON CREATE SET p.name=$id", id=phase_id)
            s.run(
                "MERGE (st:Story {id:$id}) SET "
                "st.title=$title, st.completed=true, st.costUsd=$cost, "
                "st.tokensIn=$ti, st.tokensOut=$to, st.elapsedMinutes=$el, "
                "st.startedAt=$sa, st.completedAt=$ea",
                id=sid, title=e.get("story_title",""),
                cost=float(e.get("task_cost_usd",0)),
                ti=int(e.get("task_tokens_in",0)), to=int(e.get("task_tokens_out",0)),
                el=float(e.get("elapsed_minutes",0)),
                sa=e.get("started_at",""), ea=e.get("ended_at","")
            )
            s.run("MERGE (a:Agent {id:$id}) ON CREATE SET a.name=$id", id=agent_id)
            s.run("MATCH (p:Phase {id:$pid}),(st:Story {id:$sid}) MERGE (p)-[:HAS_STORY]->(st)",
                  pid=phase_id, sid=sid)
            s.run("MATCH (a:Agent {id:$aid}),(st:Story {id:$sid}) MERGE (a)-[:IMPLEMENTED]->(st)",
                  aid=agent_id, sid=sid)
            count += 1
        ok(f"Imported {count} story executions")

    # phase-gates.jsonl -- gate decisions (multi-line JSON)
    gates_log = LOG_DIR / "phase-gates.jsonl"
    if gates_log.exists() and gates_log.stat().st_size > 0:
        log("Importing gate decisions from phase-gates.jsonl...")
        count = 0
        for obj in parse_jsonl_multiobj(gates_log):
            phase_id = obj.get("phase_id", "unknown")
            if PHASE_FILTER and phase_id != PHASE_FILTER:
                continue
            ts        = obj.get("timestamp", "")
            decision  = obj.get("decision", "unknown")
            criteria  = obj.get("criteria", {})
            variance  = criteria.get("cost_variance_pct", 0)
            cost_tier = criteria.get("cost_tier", "ok")
            gate_id   = f"gate_{phase_id}_{ts}".replace(":", "").replace("-", "")[:50]
            s.run(
                "MERGE (g:GateDecision {id:$id}) SET "
                "g.phaseId=$pid, g.decision=$dec, g.costVariancePct=$var, "
                "g.costTier=$tier, g.timestamp=$ts",
                id=gate_id, pid=phase_id, dec=decision,
                var=float(variance), tier=cost_tier, ts=ts
            )
            s.run("MATCH (p:Phase {id:$pid}),(g:GateDecision {id:$gid}) MERGE (p)-[:HAS_GATE]->(g)",
                  pid=phase_id, gid=gate_id)
            count += 1
        ok(f"Imported {count} gate decisions")

    # agent-messages.jsonl
    msgs_log = LOG_DIR / "agent-messages.jsonl"
    if msgs_log.exists() and msgs_log.stat().st_size > 0:
        log("Importing agent messages from agent-messages.jsonl...")
        count = 0
        for line in msgs_log.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg_id     = m.get("id") or f"msg_{m.get('timestamp','')}{m.get('from','')}".replace(":","")\
                                                                                          .replace("-","")[:40]
            from_agent = m.get("from", "unknown")
            to_agent   = m.get("to", "broadcast")
            subject    = m.get("subject", "")[:120]
            priority   = m.get("priority", "normal")
            timestamp  = m.get("timestamp", "")
            for aid in (from_agent, to_agent):
                s.run("MERGE (a:Agent {id:$id}) ON CREATE SET a.name=$id", id=aid)
            s.run(
                "MERGE (msg:Message {id:$id}) SET "
                "msg.subject=$sub, msg.priority=$pri, msg.timestamp=$ts, "
                "msg.from=$frm, msg.to=$to",
                id=msg_id, sub=subject, pri=priority, ts=timestamp,
                frm=from_agent, to=to_agent
            )
            s.run("MATCH (a:Agent {id:$aid}),(msg:Message {id:$mid}) MERGE (a)-[:SENT]->(msg)",
                  aid=from_agent, mid=msg_id)
            s.run("MATCH (msg:Message {id:$mid}),(a:Agent {id:$aid}) MERGE (msg)-[:RECEIVED_BY]->(a)",
                  mid=msg_id, aid=to_agent)
            count += 1
        ok(f"Imported {count} messages")

    # -- Summary + write stats file --
    print()
    log("Graph summary:")
    counts = {}
    for rec in s.run("MATCH (n) RETURN labels(n)[0] AS lbl, count(n) AS cnt ORDER BY cnt DESC"):
        label, cnt = rec["lbl"], rec["cnt"]
        counts[label] = cnt
        print(f"  {label}: {cnt}")
    rel_count = s.run("MATCH ()-[r]->() RETURN count(r) AS cnt").single()["cnt"]
    print(f"  Relationships: {rel_count}")

    # Write stats JSON for dashboard fallback (Aura blocks browser HTTP API)
    stats = {
        "loadedAt": datetime.utcnow().isoformat() + "Z",
        "boltUrl":  BOLT_URL,
        "phase":    PHASE_FILTER or "all",
        "nodes":    counts,
        "relationships": rel_count
    }
    stats_file = LOG_DIR / "neo4j-stats.json"
    stats_file.write_text(json.dumps(stats, indent=2))
    ok(f"Stats cached -> {stats_file}")

driver.close()
print()
ok(f"Graph loaded -- open Bloom at https://workspace.neo4j.io/workspace/bloom")
