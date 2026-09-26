/** Real MCP client over Streamable HTTP plus result helpers. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function connect(port: string, name: string): Promise<Client> {
  const client = new Client({ name: `schemaforge-e2e-${name}`, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export interface ToolOutcome {
  isError: boolean;
  data: Json;
}

/** Call a tool and return its structured content (falling back to parsed text content). */
export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  let data = result.structuredContent as Json | undefined;
  if (!data) {
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === 'text')?.text ?? '{}';
    try {
      data = JSON.parse(text) as Json;
    } catch {
      data = { raw: text };
    }
  }
  return { isError: result.isError === true, data };
}
