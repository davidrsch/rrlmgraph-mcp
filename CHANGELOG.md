# Changelog

All notable changes to `rrlmgraph-mcp` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-02-22

### Added

- **SQLite schema** (`src/db/schema.sql`) with FTS5 virtual table, indexes, and
  incremental migration support (schema_version in graph_metadata). Closes #1.
- **`SQLiteGraph` class** (`src/db/sqlite_reader.ts`) — pure TypeScript BFS
  traversal using recursive CTE; TF-IDF cosine re-ranking; FTS5 seed-node
  discovery; no R subprocess required. Closes #2.
- **`query_context` MCP tool** — graph BFS traversal with token budget, seed node
  anchoring, and metadata footer. Closes #3.
- **`get_node_info` MCP tool** — full node details: signature, documentation,
  callers/callees/tests, metrics; similar-node suggestions on miss. Closes #4.
- **`rebuild_graph` MCP tool** — triggers `Rscript` subprocess, streams output,
  graceful error on missing R installation. Closes #5.
- **`add_task_trace` MCP tool** — writes task outcomes to `task_traces` SQLite
  table for relevance feedback loop; polarity validation. Closes #6.
- **MCP Resources**: `rrlmgraph://summary`, `rrlmgraph://file/{path}`,
  `rrlmgraph://task-history`. Closes #7.
- **Server entry point** (`src/index.ts`) — stdio transport, environment variable
  configuration, `--help` / `--version` CLI flags, auto-detect project path from
  cwd. Closes #8.
- **Python fallback server** (`python/server.py` + `python/db.py`) using
  `fastmcp`; same 4 tools and 3 resources as TypeScript server. Closes #9.
- **Unit tests** (`tests/unit/sqlite_reader.test.ts`) with snapshot SQLite
  fixture; **integration tests** (`tests/integration/integration.test.ts`) using
  `@modelcontextprotocol/sdk` client over stdio. Closes #10.
- **npm packaging** (`package.json` bin field, `npx rrlmgraph-mcp`), README,
  CHANGELOG, GitHub Actions CI + publish workflows. Closes #11.
- `templates/mcp.json.template` for quick VS Code `.vscode/mcp.json` setup.
