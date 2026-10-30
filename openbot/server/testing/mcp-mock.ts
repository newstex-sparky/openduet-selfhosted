/**
 * A deterministic MCP server, in the repo.
 *
 * This is the repo's own MCP mock. It is built on `@modelcontextprotocol/sdk` — the
 * same SDK the product's own client uses — rather than on a hand-rolled JSON-RPC dispatcher, so the
 * tools a test registers really cross a Streamable-HTTP MCP connection. `mcp.ts` is the one door
 * here that speaks MCP to somebody else's server; a stubbed `fetch` would prove only that we parse
 * what we already believe the protocol says.
 *
 * The tool definitions are served verbatim, `annotations` included: the point of the listing tests is
 * what a server declares, and a mock that dropped the fields it did not know about would hide the
 * drift those tests exist to catch.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** One piece of a tool result, in MCP's own vocabulary. */
export type MCPContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: {
        uri: string;
        text?: string;
        blob?: string;
        mimeType?: string;
      };
    };

/** A tool as a server declares it. Unknown fields (`annotations`, `title`, …) are served verbatim. */
export type MCPToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
} & Record<string, unknown>;

/** What a tool answers: plain text, or MCP content. A throw becomes an `isError` result. */
export type MCPToolHandler = (
  args: Record<string, unknown>,
) => string | MCPContent[] | Promise<string | MCPContent[]>;

type RegisteredTool = {
  definition: MCPToolDefinition;
  handler?: MCPToolHandler;
};

/** A scriptable MCP server on a loopback port. */
export class MCPMock {
  #tools: RegisteredTool[] = [];
  #server: Bun.Server<undefined> | undefined;
  #options: { port?: number; host?: string };

  constructor(options: { port?: number; host?: string } = {}) {
    this.#options = options;
  }

  /** Declare a tool. Chainable, so a fixture reads as one list. */
  addTool(definition: MCPToolDefinition): this {
    const existing = this.#tools.find(
      (tool) => tool.definition.name === definition.name,
    );
    if (existing) existing.definition = definition;
    else this.#tools.push({ definition });
    return this;
  }

  /** Answer calls to `name` with whatever the handler returns. */
  onToolCall(name: string, handler: MCPToolHandler): this {
    const existing = this.#tools.find((tool) => tool.definition.name === name);
    if (existing) existing.handler = handler;
    else this.#tools.push({ definition: { name }, handler });
    return this;
  }

  /** Start listening and answer with the MCP endpoint URL. */
  start(): Promise<string> {
    if (this.#server) return Promise.resolve(this.#server.url.origin);
    this.#server = Bun.serve({
      port: this.#options.port ?? 0,
      hostname: this.#options.host ?? "127.0.0.1",
      fetch: (request) => this.#handle(request),
    });
    return Promise.resolve(this.#server.url.origin);
  }

  /** Stop listening. Safe to call when it never started. */
  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server) await server.stop(true);
  }

  get url(): string {
    return this.#server?.url.origin ?? "";
  }

  /** One server and one transport per request: stateless, so no session can leak between tests. */
  async #handle(request: Request): Promise<Response> {
    const server = new Server(
      { name: "openbot-mcp-mock", version: "1.0.0" },
      { capabilities: { tools: {}, prompts: {}, resources: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.#tools.map((tool) => tool.definition),
    }));
    server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: [],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const name = call.params.name;
      const tool = this.#tools.find(
        (candidate) => candidate.definition.name === name,
      );
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      if (!tool.handler)
        return { content: [{ type: "text", text: `No handler for ${name}.` }] };
      try {
        const answer = await tool.handler(
          (call.params.arguments ?? {}) as Record<string, unknown>,
        );
        const content =
          typeof answer === "string"
            ? [{ type: "text" as const, text: answer }]
            : answer;
        return { content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: false,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  }
}
