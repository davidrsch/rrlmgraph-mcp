"""
rrlmgraph-mcp Python fallback server using fastmcp.

Implements the same 4 tools and 3 resources as the TypeScript server.
Useful in environments where Node.js is unavailable.

Usage:
    python python/server.py [--project-path /path/to/project] [--db-path /path/to/graph.sqlite]

Install:
    pip install rrlmgraph-mcp
    # or
    uv tool install rrlmgraph-mcp

Issue: rrlmgraph-mcp #9
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

from fastmcp import FastMCP
from fastmcp.resources import Resource

# Add parent directory to path so we can import db
sys.path.insert(0, str(Path(__file__).parent))
from db import SQLiteGraph  # noqa: E402

# ── Argument parsing ──────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="rrlmgraph-mcp Python server")
parser.add_argument("--project-path", default=None)
parser.add_argument("--db-path", default=None)
args, _ = parser.parse_known_args()

project_path = Path(
    args.project_path
    or os.environ.get("RRLMGRAPH_PROJECT_PATH", "")
    or Path.cwd()
).resolve()

db_path = Path(
    args.db_path
    or os.environ.get("RRLMGRAPH_DB_PATH", "")
    or project_path / ".rrlmgraph" / "graph.sqlite"
)

default_budget = int(os.environ.get("RRLMGRAPH_BUDGET_TOKENS", "6000"))

# ── Graph initialisation ──────────────────────────────────────────────────────

graph = SQLiteGraph(str(db_path))

# ── FastMCP server ────────────────────────────────────────────────────────────

mcp = FastMCP(
    "rrlmgraph-mcp",
    version="0.1.0",
    description="MCP server for rrlmgraph — graph-based R project context for LLM coding assistants",
)

# ─── Tools ────────────────────────────────────────────────────────────────────


@mcp.tool(
    description=(
        "Query the RLM-Graph for R project context relevant to a coding task. "
        "Returns structured context (function signatures, documentation, source) "
        "within a configurable token budget."
    )
)
def query_context(
    query: str,
    budget_tokens: int = 6000,
    seed_node: Optional[str] = None,
) -> str:
    """
    Args:
        query: Natural language description of the coding task.
        budget_tokens: Token budget for returned context (default: 6000).
        seed_node: Optional function name to anchor the graph traversal.
    """
    result = graph.query_context(query, seed_node, budget_tokens)
    footer = (
        f"---\n**Nodes retrieved**: {len(result.node_ids)}\n"
        f"**Token estimate**: ~{result.token_estimate}\n"
        f"**Seed node**: {result.seed_node or '(none)'}"
    )
    return result.context_string + "\n" + footer


@mcp.tool(
    description=(
        "Retrieve full details for a specific R function or node in the graph: "
        "signature, documentation, callers, callees, and test coverage."
    )
)
def get_node_info(node_name: str, include_source: bool = False) -> str:
    """
    Args:
        node_name: Exact name of the function or node.
        include_source: Include full function body source code (default: False).
    """
    info = graph.get_node_info(node_name, include_source)
    if info is None:
        similar = graph.find_similar_nodes(node_name)
        hint = f"\n\nDid you mean one of: {', '.join(f'`{n}`' for n in similar)}?" if similar else ""
        return f"Node `{node_name}` not found in the graph.{hint}"

    lines = [
        f"# {info.name}",
        f"**Type**: {info.node_type or 'unknown'}",
        f"**File**: {info.file or 'unknown'}",
    ]
    if info.pkg_name:
        lines.append(f"**Package**: {info.pkg_name}{f' v{info.pkg_version}' if info.pkg_version else ''}")
    if info.signature:
        lines.append(f"\n**Signature**:\n```r\n{info.signature}\n```")
    if info.roxygen_text:
        lines.append(f"\n**Documentation**:\n{info.roxygen_text}")
    if info.callers:
        lines.append(f"\n**Called by**: {', '.join(f'`{c}`' for c in info.callers)}")
    if info.callees:
        lines.append(f"\n**Calls**: {', '.join(f'`{c}`' for c in info.callees)}")
    if info.tests:
        lines.append(f"\n**Tested by**: {', '.join(f'`{t}`' for t in info.tests)}")
    metrics = []
    if info.pagerank is not None:
        metrics.append(f"PageRank: {info.pagerank:.4f}")
    if info.complexity is not None:
        metrics.append(f"Complexity: {info.complexity}")
    if info.task_weight is not None:
        metrics.append(f"Task weight: {info.task_weight:.3f}")
    if metrics:
        lines.append(f"\n**Metrics**: {' | '.join(metrics)}")
    if include_source and info.body_text:
        lines.append(f"\n**Source**:\n```r\n{info.body_text}\n```")

    return "\n".join(lines)


@mcp.tool(
    description=(
        "Trigger a rebuild of the R project code graph via an Rscript subprocess. "
        "Streams build progress. On completion, the in-memory graph is refreshed."
    )
)
def rebuild_graph(incremental: bool = True, project_path_override: Optional[str] = None) -> str:
    """
    Args:
        incremental: Use incremental rebuild (default: True).
        project_path_override: Override the project path set at server startup.
    """
    proj = project_path_override or str(project_path)
    r_func = "rrlmgraph::update_graph_incremental" if incremental else "rrlmgraph::build_rrlm_graph"
    r_code = f"{r_func}('{proj}', cache = TRUE)"
    try:
        result = subprocess.run(
            ["Rscript", "--vanilla", "-e", r_code],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode == 0:
            graph.reload()
            label = "incremental" if incremental else "full"
            output = (result.stdout + result.stderr).strip()
            return f"✅ Graph rebuilt successfully ({label}).\n\n**Output:**\n```\n{output}\n```"
        else:
            output = (result.stdout + result.stderr).strip()
            return f"❌ R process exited with code {result.returncode}.\n\n**Output:**\n```\n{output}\n```"
    except FileNotFoundError:
        return (
            "**Error**: `Rscript` not found. "
            "Please install R and ensure it is on your PATH.\n\n"
            "Download R from: https://cran.r-project.org/"
        )


@mcp.tool(
    description=(
        "Record the outcome of an LLM coding task as feedback for the graph relevance loop. "
        "Call after a task is accepted (+polarity) or rejected (−polarity)."
    )
)
def add_task_trace(
    query: str,
    nodes: list[str],
    polarity: float = 0.0,
    session_id: Optional[str] = None,
) -> str:
    """
    Args:
        query: The coding task description sent to the LLM.
        nodes: Node IDs relevant to this task.
        polarity: 1.0 = accepted, -1.0 = rejected, 0 = neutral (default: 0).
        session_id: Optional session identifier.
    """
    if polarity < -1 or polarity > 1:
        return f"Error: polarity must be in [-1, 1], got {polarity}"
    trace_id = graph.add_task_trace(query, nodes, polarity, session_id)
    sign = "+" if polarity >= 0 else ""
    return (
        f"✅ Task trace recorded.\n"
        f"**Trace ID**: {trace_id}\n"
        f"**Polarity**: {sign}{polarity}\n"
        f"**Nodes**: {len(nodes)} recorded"
    )


# ─── Resources ────────────────────────────────────────────────────────────────


@mcp.resource("rrlmgraph://summary")
def summary_resource() -> str:
    """Graph overview: node/edge counts, top hubs, build time, embed method."""
    s = graph.get_graph_summary()
    lines = [
        "# rrlmgraph Graph Summary",
        "",
        "| Property | Value |",
        "|---|---|",
        f"| Nodes | {s.node_count} |",
        f"| Edges | {s.edge_count} |",
        f"| Build time | {s.build_time or 'unknown'} |",
        f"| rrlmgraph version | {s.rrlmgraph_version or 'unknown'} |",
        f"| Embed method | {s.embed_method or 'tfidf'} |",
        f"| Project root | {s.project_root or 'unknown'} |",
        "",
        "## Node types",
        *[f"- **{t}**: {c}" for t, c in s.node_types.items()],
        "",
        "## Edge types",
        *[f"- **{t}**: {c}" for t, c in s.edge_types.items()],
        "",
        "## Top 10 PageRank hubs",
        *[f"{i+1}. `{h['name']}` — PageRank {h['pagerank']:.5f}" for i, h in enumerate(s.top_hubs)],
    ]
    return "\n".join(lines)


@mcp.resource("rrlmgraph://file/{path}")
def file_nodes_resource(path: str) -> str:
    """All graph nodes extracted from a specific source file."""
    nodes = graph.get_file_nodes(path)
    lines = [f"# Nodes in `{path}`", "", f"**{len(nodes)} node{'s' if len(nodes) != 1 else ''} found.**", ""]
    if not nodes:
        lines.append(f"No nodes found for `{path}`.")
    else:
        for node in nodes:
            lines.append(f"## `{node.name}`")
            if node.node_type:
                lines.append(f"**Type**: {node.node_type}")
            if node.signature:
                lines.append(f"**Signature**:\n```r\n{node.signature}\n```")
            if node.roxygen_text:
                lines.append(f"**Documentation**:\n{node.roxygen_text[:300]}")
            lines.append("")
    return "\n".join(lines)


@mcp.resource("rrlmgraph://task-history")
def task_history_resource() -> str:
    """Last 20 LLM task trace entries."""
    traces = graph.get_task_history(20)
    lines = [f"# Task History", "", f"**{len(traces)} trace{'s' if len(traces) != 1 else ''} recorded.**", ""]
    if not traces:
        lines.append("No task traces recorded yet. Call `add_task_trace` after coding tasks.")
    else:
        for t in traces:
            if t.polarity > 0.1:
                label = "✅ positive"
            elif t.polarity < -0.1:
                label = "❌ negative"
            else:
                label = "➖ neutral"
            lines += [
                f"## Trace #{t.trace_id}",
                f"- **Query**: {t.query or '(none)'}",
                f"- **Polarity**: {label} ({t.polarity})",
                f"- **Nodes**: {', '.join(t.nodes) or '(none)'}",
                f"- **Time**: {t.created_at or 'unknown'}",
                "",
            ]
    return "\n".join(lines)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run(transport="stdio")
