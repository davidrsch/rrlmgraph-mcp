# rrlmgraph-mcp

> **Model Context Protocol server for [rrlmgraph](https://github.com/davidrsch/rrlmgraph)** — delivers graph-based R project context to LLM coding assistants.

## What it does

`rrlmgraph` builds a typed code graph of your R project (functions, imports, tests, git co-changes, S4 dispatch).  
`rrlmgraph-mcp` exposes that graph as an MCP server so that LLM hosts (VS Code Copilot, Continue, Claude Desktop, …) can:

1. **Retrieve relevant context** for any coding task via BFS graph traversal
2. **Drill down** into specific function signatures and documentation
3. **Trigger graph rebuilds** without leaving the editor
4. **Record task outcomes** to feed the relevance improvement loop

## Quick start

### Prerequisites

- Node.js ≥ 18
- An R project with `rrlmgraph` installed and a graph already exported:

```r
# In your R project:
library(rrlmgraph)
g <- build_rrlm_graph(".")
export_to_sqlite(g)  # writes .rrlmgraph/graph.sqlite
```

### Run via npx (no install)

```sh
npx rrlmgraph-mcp --project-path /path/to/your/r-project
```

### Install globally

```sh
npm install -g rrlmgraph-mcp
rrlmgraph-mcp --project-path /path/to/your/r-project
```

### VS Code configuration

Copy [templates/mcp.json.template](templates/mcp.json.template) to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "rrlmgraph": {
      "type": "stdio",
      "command": "npx",
      "args": ["rrlmgraph-mcp", "--project-path", "${workspaceFolder}"]
    }
  }
}
```

---

## Tools

### `query_context`

Query the graph for context relevant to a coding task. Returns function bodies, signatures, and documentation within a token budget.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | **required** | Natural language task description |
| `budget_tokens` | number | 6000 | Token budget for returned context |
| `seed_node` | string | — | Optional function name to anchor traversal |

### `get_node_info`

Retrieve full details for a specific function or node.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `node_name` | string | **required** | Exact function/node name |
| `include_source` | boolean | false | Include full function body |

### `rebuild_graph`

Trigger an R subprocess to rebuild the code graph.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `incremental` | boolean | true | Use incremental rebuild |
| `project_path` | string | — | Override project path |

### `add_task_trace`

Record LLM task outcome as graph feedback for the relevance improvement loop.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | **required** | Task description |
| `nodes` | string[] | **required** | Relevant node IDs |
| `polarity` | number | 0 | −1 (rejected) to +1 (accepted) |
| `session_id` | string | — | Optional session grouping |

---

## Resources

| URI | Description |
|---|---|
| `rrlmgraph://summary` | Graph overview: counts, top hubs, build time |
| `rrlmgraph://file/{path}` | All nodes from a specific source file |
| `rrlmgraph://task-history` | Last 20 task trace entries |

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RRLMGRAPH_PROJECT_PATH` | `cwd` | R project root |
| `RRLMGRAPH_DB_PATH` | `<project>/.rrlmgraph/graph.sqlite` | SQLite file path |
| `RRLMGRAPH_BUDGET_TOKENS` | `6000` | Default token budget |
| `RRLMGRAPH_EMBED_METHOD` | `tfidf` | Embedding hint passed to R |

---

## Python fallback

If Node.js is unavailable, use the Python server:

```sh
pip install rrlmgraph-mcp     # or: uv tool install rrlmgraph-mcp
python -m rrlmgraph_mcp --project-path /path/to/project
```

Or directly:

```sh
python python/server.py --project-path /path/to/project
```

---

## Development

```sh
npm install
npm run build       # TypeScript → dist/
npm test            # unit tests (vitest)
npx tsx src/index.ts --project-path /path/to/project   # dev mode
```

### Generate test fixture

```sh
npx tsx tests/fixtures/create_fixture.ts
```

---

## Architecture

```
rrlmgraph (R package)
  └── export_to_sqlite()  →  .rrlmgraph/graph.sqlite
                                     │
                         ┌───────────▼────────────┐
                         │    rrlmgraph-mcp        │
                         │  (TypeScript MCP server)│
                         │  src/db/sqlite_reader.ts│  ← BFS CTE + TF-IDF re-rank
                         │  src/tools/             │  ← 4 MCP tools
                         │  src/resources/         │  ← 3 MCP resources
                         └───────────┬────────────┘
                                     │  stdio transport
                         ┌───────────▼────────────┐
                         │   LLM host              │
                         │ (VS Code / Continue /   │
                         │  Claude Desktop / …)    │
                         └─────────────────────────┘
```

---

## License

MIT — see [LICENSE](LICENSE).
