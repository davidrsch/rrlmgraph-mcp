"""
SQLite reader for rrlmgraph — Python port of the TypeScript SQLiteGraph class.

Used by the rrlmgraph-mcp Python fallback server (server.py).

Issue: rrlmgraph-mcp #9
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# ── Data classes ──────────────────────────────────────────────────────────────


@dataclass
class NodeInfo:
    node_id: str
    name: str
    file: Optional[str]
    node_type: Optional[str]
    signature: Optional[str]
    body_text: Optional[str]
    roxygen_text: Optional[str]
    complexity: Optional[float]
    pagerank: Optional[float]
    task_weight: Optional[float]
    pkg_name: Optional[str]
    pkg_version: Optional[str]
    callers: list[str] = field(default_factory=list)
    callees: list[str] = field(default_factory=list)
    tests: list[str] = field(default_factory=list)


@dataclass
class ContextResult:
    context_string: str
    node_ids: list[str]
    token_estimate: int
    seed_node: Optional[str]


@dataclass
class GraphSummary:
    node_count: int
    edge_count: int
    node_types: dict[str, int]
    edge_types: dict[str, int]
    top_hubs: list[dict]
    build_time: Optional[str]
    rrlmgraph_version: Optional[str]
    embed_method: Optional[str]
    project_root: Optional[str]


@dataclass
class TaskTrace:
    trace_id: int
    query: Optional[str]
    nodes: list[str]
    polarity: float
    session_id: Optional[str]
    created_at: Optional[str]


# ── Helpers ───────────────────────────────────────────────────────────────────


def _estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 3.5))


def _tokenize(text: str) -> list[str]:
    return [t for t in re.sub(r"[^a-z0-9_.]", " ", text.lower()).split() if len(t) > 1]


def _cosine(a: list[float], b: list[float]) -> float:
    min_len = min(len(a), len(b))
    if min_len == 0:
        return 0.0
    dot = sum(a[i] * b[i] for i in range(min_len))
    norm_a = math.sqrt(sum(x * x for x in a[:min_len]))
    norm_b = math.sqrt(sum(x * x for x in b[:min_len]))
    denom = norm_a * norm_b
    return dot / denom if denom > 0 else 0.0


# ── SQLiteGraph ───────────────────────────────────────────────────────────────


class SQLiteGraph:
    def __init__(self, db_path: str) -> None:
        self._db_path = str(Path(db_path).resolve())
        self._conn = sqlite3.connect(self._db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._ensure_schema()
        self._vocab: dict[str, tuple[float, int, int]] = {}
        self._load_vocab()

    # ── Schema ────────────────────────────────────────────────────────────────

    def _ensure_schema(self) -> None:
        schema_path = Path(__file__).parent.parent / "src" / "db" / "schema.sql"
        if schema_path.exists():
            sql = schema_path.read_text(encoding="utf-8")
            # Execute statement by statement, skipping failures (triggers may
            # already exist; FTS virtual tables may not be supported)
            for stmt in sql.split(";"):
                stmt = stmt.strip()
                if stmt:
                    try:
                        self._conn.execute(stmt)
                    except sqlite3.OperationalError:
                        pass
            self._conn.commit()

    def _load_vocab(self) -> None:
        try:
            cur = self._conn.execute("SELECT term, idf, doc_count, term_count FROM tfidf_vocab")
            self._vocab = {row["term"]: (row["idf"], row["doc_count"], row["term_count"]) for row in cur}
        except sqlite3.OperationalError:
            pass

    # ── Metadata ──────────────────────────────────────────────────────────────

    def _get_meta(self, key: str) -> Optional[str]:
        cur = self._conn.execute("SELECT value FROM graph_metadata WHERE key = ?", (key,))
        row = cur.fetchone()
        return row["value"] if row else None

    def _set_meta(self, key: str, value: str) -> None:
        self._conn.execute(
            "INSERT INTO graph_metadata(key, value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        self._conn.commit()

    # ── Seed node ─────────────────────────────────────────────────────────────

    def _find_seed_node(self, query: str, seed_node_name: Optional[str] = None) -> Optional[str]:
        if seed_node_name:
            cur = self._conn.execute("SELECT node_id FROM nodes WHERE name = ? LIMIT 1", (seed_node_name,))
            row = cur.fetchone()
            if row:
                return row["node_id"]

        # FTS5
        try:
            tokens = _tokenize(query)[:10]
            fts_query = " OR ".join(tokens)
            if fts_query:
                cur = self._conn.execute(
                    "SELECT n.node_id FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid "
                    "WHERE nodes_fts MATCH ? ORDER BY rank LIMIT 1",
                    (fts_query,),
                )
                row = cur.fetchone()
                if row:
                    return row["node_id"]
        except sqlite3.OperationalError:
            pass

        # TF-IDF overlap fallback
        tokens_set = set(_tokenize(query))
        cur = self._conn.execute("SELECT node_id, name, pagerank FROM nodes ORDER BY pagerank DESC NULLS LAST LIMIT 200")
        best_score = 0.0
        best_id: Optional[str] = None
        for row in cur:
            overlap = sum(1 for t in _tokenize(row["name"]) if t in tokens_set)
            score = overlap + (row["pagerank"] or 0)
            if score > best_score:
                best_score = score
                best_id = row["node_id"]
        if best_id:
            return best_id

        # Highest pagerank
        cur = self._conn.execute("SELECT node_id FROM nodes ORDER BY pagerank DESC NULLS LAST LIMIT 1")
        row = cur.fetchone()
        return row["node_id"] if row else None

    # ── BFS ───────────────────────────────────────────────────────────────────

    _BFS_SQL = """
    WITH RECURSIVE bfs(node_id, depth) AS (
      SELECT n.node_id, 0
      FROM   nodes n
      WHERE  n.node_id = :seed_node

      UNION ALL

      SELECT e.target_id, bfs.depth + 1
      FROM   edges  e
      JOIN   bfs    ON e.source_id = bfs.node_id
      WHERE  bfs.depth < :max_depth
        AND  NOT EXISTS (
               SELECT 1 FROM bfs b2 WHERE b2.node_id = e.target_id
             )
    )
    SELECT DISTINCT n.*, bfs.depth
    FROM   bfs
    JOIN   nodes n ON n.node_id = bfs.node_id
    ORDER  BY bfs.depth ASC, n.pagerank DESC
    LIMIT  :max_nodes
    """

    def query_context(
        self,
        query: str,
        seed_node_name: Optional[str] = None,
        budget_tokens: int = 6000,
        max_depth: int = 3,
        max_nodes: int = 80,
    ) -> ContextResult:
        seed_id = self._find_seed_node(query, seed_node_name)

        if not seed_id:
            return ContextResult(
                context_string="# No graph data available.\n",
                node_ids=[],
                token_estimate=0,
                seed_node=None,
            )

        cur = self._conn.execute(
            self._BFS_SQL,
            {"seed_node": seed_id, "max_depth": max_depth, "max_nodes": max_nodes},
        )
        bfs_nodes = [dict(row) for row in cur]

        # Build TF-IDF query vector
        q_tokens = _tokenize(query)
        tf: dict[str, float] = {}
        for t in q_tokens:
            tf[t] = tf.get(t, 0) + 1
        n = max(len(q_tokens), 1)
        q_vec = {term: (count / n) * self._vocab[term][0] for term, count in tf.items() if term in self._vocab}
        q_vec_arr = list(q_vec.values())

        # Score
        scored = []
        for node in bfs_nodes:
            sem_score = 0.0
            if node.get("embedding") and q_vec_arr:
                try:
                    emb = json.loads(node["embedding"])
                    sem_score = _cosine(q_vec_arr, emb[: len(q_vec_arr)])
                except (json.JSONDecodeError, TypeError):
                    pass
            pr = node.get("pagerank") or 0.0
            tw = node.get("task_weight") or 0.5
            depth_pen = 1 / (1 + (node.get("depth") or 0) * 0.5)
            score = 0.4 * sem_score + 0.35 * pr + 0.15 * tw + 0.1 * depth_pen
            scored.append((score, node))

        scored.sort(key=lambda x: x[0], reverse=True)

        chunks: list[str] = []
        used_ids: list[str] = []
        used_tokens = 0

        for _, node in scored:
            chunk = self._format_node(node)
            ct = _estimate_tokens(chunk)
            if used_tokens + ct > budget_tokens:
                break
            chunks.append(chunk)
            used_ids.append(node["node_id"])
            used_tokens += ct

        header = f"# rrlmgraph context\n# Query: {query}\n# Nodes: {len(used_ids)} | Tokens: ~{used_tokens}\n\n"
        return ContextResult(
            context_string=header + "\n---\n".join(chunks),
            node_ids=used_ids,
            token_estimate=used_tokens,
            seed_node=seed_id,
        )

    def _format_node(self, node: dict) -> str:
        lines = []
        ntype = node.get("node_type") or "node"
        file_ = f" [{node['file']}]" if node.get("file") else ""
        lines.append(f"## {node['name']}  <{ntype}>{file_}")
        if node.get("signature"):
            lines.append(f"**Signature**: `{node['signature']}`")
        if node.get("roxygen_text"):
            lines.append("**Documentation**:")
            lines.append(node["roxygen_text"][:400])
        if node.get("body_text"):
            lines.append("```r")
            lines.append(node["body_text"][:1200])
            lines.append("```")
        return "\n".join(lines)

    # ── getNodeInfo ───────────────────────────────────────────────────────────

    def get_node_info(self, node_name: str, include_source: bool = False) -> Optional[NodeInfo]:
        cur = self._conn.execute("SELECT * FROM nodes WHERE name = ? LIMIT 1", (node_name,))
        row = cur.fetchone()
        if not row:
            return None
        node = dict(row)
        node_id = node["node_id"]

        callers = [
            r["name"]
            for r in self._conn.execute(
                "SELECT n.name FROM edges e JOIN nodes n ON n.node_id = e.source_id "
                "WHERE e.target_id = ? AND e.edge_type = 'CALLS' LIMIT 20",
                (node_id,),
            )
        ]
        callees = [
            r["name"]
            for r in self._conn.execute(
                "SELECT n.name FROM edges e JOIN nodes n ON n.node_id = e.target_id "
                "WHERE e.source_id = ? AND e.edge_type = 'CALLS' LIMIT 20",
                (node_id,),
            )
        ]
        tests = [
            r["name"]
            for r in self._conn.execute(
                "SELECT n.name FROM edges e JOIN nodes n ON n.node_id = e.source_id "
                "WHERE e.target_id = ? AND e.edge_type = 'TESTS' LIMIT 20",
                (node_id,),
            )
        ]

        return NodeInfo(
            node_id=node_id,
            name=node["name"],
            file=node.get("file"),
            node_type=node.get("node_type"),
            signature=node.get("signature"),
            body_text=node.get("body_text") if include_source else None,
            roxygen_text=node.get("roxygen_text"),
            complexity=node.get("complexity"),
            pagerank=node.get("pagerank"),
            task_weight=node.get("task_weight"),
            pkg_name=node.get("pkg_name"),
            pkg_version=node.get("pkg_version"),
            callers=callers,
            callees=callees,
            tests=tests,
        )

    def find_similar_nodes(self, name: str, limit: int = 5) -> list[str]:
        tokens = _tokenize(name)
        if not tokens:
            return []
        try:
            fts_query = " OR ".join(f"{t}*" for t in tokens)
            cur = self._conn.execute(
                "SELECT n.name FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid "
                "WHERE nodes_fts MATCH ? LIMIT ?",
                (fts_query, limit),
            )
            return [r["name"] for r in cur]
        except sqlite3.OperationalError:
            return []

    # ── getGraphSummary ───────────────────────────────────────────────────────

    def get_graph_summary(self) -> GraphSummary:
        node_count = self._conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
        edge_count = self._conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]

        node_types: dict[str, int] = {
            row[0] or "unknown": row[1]
            for row in self._conn.execute("SELECT node_type, COUNT(*) FROM nodes GROUP BY node_type")
        }
        edge_types: dict[str, int] = {
            row[0] or "unknown": row[1]
            for row in self._conn.execute("SELECT edge_type, COUNT(*) FROM edges GROUP BY edge_type")
        }
        top_hubs = [
            {"name": row[0], "pagerank": row[1] or 0.0}
            for row in self._conn.execute(
                "SELECT name, pagerank FROM nodes ORDER BY pagerank DESC NULLS LAST LIMIT 10"
            )
        ]
        return GraphSummary(
            node_count=node_count,
            edge_count=edge_count,
            node_types=node_types,
            edge_types=edge_types,
            top_hubs=top_hubs,
            build_time=self._get_meta("build_time"),
            rrlmgraph_version=self._get_meta("rrlmgraph_version"),
            embed_method=self._get_meta("embed_method"),
            project_root=self._get_meta("project_root"),
        )

    # ── getFileNodes ──────────────────────────────────────────────────────────

    def get_file_nodes(self, file_path: str) -> list[NodeInfo]:
        decoded = file_path  # assumed already decoded
        rows = self._conn.execute(
            "SELECT * FROM nodes WHERE file = ? OR file LIKE ?",
            (decoded, f"%{decoded}"),
        )
        result = []
        for row in rows:
            r = dict(row)
            result.append(
                NodeInfo(
                    node_id=r["node_id"],
                    name=r["name"],
                    file=r.get("file"),
                    node_type=r.get("node_type"),
                    signature=r.get("signature"),
                    body_text=r.get("body_text"),
                    roxygen_text=r.get("roxygen_text"),
                    complexity=r.get("complexity"),
                    pagerank=r.get("pagerank"),
                    task_weight=r.get("task_weight"),
                    pkg_name=r.get("pkg_name"),
                    pkg_version=r.get("pkg_version"),
                )
            )
        return result

    # ── getTaskHistory ────────────────────────────────────────────────────────

    def get_task_history(self, max_entries: int = 20) -> list[TaskTrace]:
        rows = self._conn.execute(
            "SELECT * FROM task_traces ORDER BY trace_id DESC LIMIT ?", (max_entries,)
        )
        result = []
        for row in rows:
            r = dict(row)
            try:
                nodes = json.loads(r.get("nodes_json") or "[]")
            except (json.JSONDecodeError, TypeError):
                nodes = []
            result.append(
                TaskTrace(
                    trace_id=r["trace_id"],
                    query=r.get("query"),
                    nodes=nodes,
                    polarity=r.get("polarity") or 0.0,
                    session_id=r.get("session_id"),
                    created_at=r.get("created_at"),
                )
            )
        return result

    # ── addTaskTrace ──────────────────────────────────────────────────────────

    def add_task_trace(
        self,
        query: str,
        nodes: list[str],
        polarity: float = 0.0,
        session_id: Optional[str] = None,
    ) -> int:
        if polarity < -1 or polarity > 1:
            raise ValueError(f"polarity must be in [-1, 1], got {polarity}")
        now = datetime.now(timezone.utc).isoformat()
        cur = self._conn.execute(
            "INSERT INTO task_traces(query, nodes_json, polarity, session_id, created_at) "
            "VALUES(?, ?, ?, ?, ?)",
            (query, json.dumps(nodes), polarity, session_id, now),
        )
        self._conn.commit()
        return cur.lastrowid  # type: ignore[return-value]

    def reload(self) -> None:
        self._load_vocab()

    def close(self) -> None:
        self._conn.close()
