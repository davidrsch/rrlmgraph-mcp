/**
 * Shared types for rrlmgraph-mcp MCP resources.
 * Re-uses the SDK's ReadResourceResult to ensure type compatibility.
 */

import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

export type { ReadResourceResult };

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
  read: (uri: string) => Promise<ReadResourceResult>;
}

export interface ResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType?: string;
  read: (uri: string) => Promise<ReadResourceResult>;
}
