/**
 * The registry one provider hands to the whole app: which agent answers for a given name and
 * thread, which tools the browser can run, and which cards draw their calls.
 *
 * It replaces what a vendor SDK's core object did, and it keeps the same three jobs apart:
 *
 * - **Agents** are looked up by `` `${runtimeAgentId ?? agentId}[#threadId]` ``. Threads are part of
 *   the key because two conversations with one Bot must not share a message list; the base key is
 *   also registered, so a surface that names only the agent — `useStoppedTurn` does — gets the
 *   instance the chat itself binds to instead of a second, empty one. A thread-scoped lookup adopts
 *   an unthreaded instance rather than making a rival, in either mount order.
 * - **Tools** are what the model is offered. A tool's JSON Schema is built from its zod schema by
 *   zod 4's own `z.toJSONSchema`, so the browser and the model agree on one description.
 * - **Renders** are what a call is drawn with. Registering one notifies subscribers, which is how a
 *   transcript that is already on screen picks up a card registered a moment later.
 *
 * Client-side tools are executed here, in one loop: run, answer every call a registered handler
 * owns, run again. A call that belongs to a person is not executed — it leaves the run waiting, and
 * `respondToInterrupt` is what continues it.
 */
import type { AbstractAgent } from "@ag-ui/client";
import type { Message, Tool, ToolCall } from "@ag-ui/core";
import { z } from "zod";
import { RuntimeAgent } from "./agent";
import type {
  FrontendTool,
  FrontendToolHandlerContext,
  ParametersSchema,
  ReactActivityMessageRenderer,
  ReactToolCallRenderer,
} from "./types";

/** How many times one turn may answer browser-side tools before it is left alone. */
const MAX_CLIENT_TOOL_ROUNDS = 8;

/** What a subscriber is told when the render registry changes. */
export interface CopilotKitSubscriber {
  onRenderToolCallsChanged?: (event: {
    copilotkit: CopilotKit;
    renderToolCalls: readonly ReactToolCallRenderer[];
  }) => void;
}

export interface CopilotKitSubscription {
  unsubscribe: () => void;
}

/** The agent a lookup resolved to, and the thread it is pinned to. */
interface RegisteredAgent {
  key: string;
  agent: RuntimeAgent;
  runtimeAgentId: string;
  /** The thread this instance was made for. Absent while it is still unthreaded. */
  threadId?: string;
}

/** A tool the browser can run, with the agent it was registered for. */
interface RegisteredTool {
  tool: FrontendTool<Record<string, unknown>>;
  agentId?: string;
}

export interface AgentLookup {
  agentId: string;
  runtimeAgentId?: string;
  threadId?: string;
}

export interface CopilotKitConfig {
  runtimeUrl: string;
  /** Cards configured by the provider, before any hook registers one. */
  renderToolCalls?: ReactToolCallRenderer[];
  renderActivityMessages?: ReactActivityMessageRenderer<unknown>[];
}

/**
 * The registry key for one agent and thread.
 *
 * `#threadId` is appended only when there is a thread, so the base key a threadless lookup asks for
 * is a prefix of no other key — see `agentFor` for how the two are kept pointing at one instance.
 */
export function agentKey({
  agentId,
  runtimeAgentId,
  threadId,
}: AgentLookup): string {
  const base = runtimeAgentId ?? agentId;
  return threadId ? `${base}#${threadId}` : base;
}

export class CopilotKit {
  readonly runtimeUrl: string;
  private readonly configuredRenderToolCalls: ReactToolCallRenderer[];
  private readonly configuredActivityRenderers: ReactActivityMessageRenderer<unknown>[];
  private readonly agents = new Map<string, RegisteredAgent>();
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly hookRenderers = new Map<string, ReactToolCallRenderer>();
  private readonly hookActivityRenderers = new Map<
    string,
    ReactActivityMessageRenderer<unknown>
  >();
  private readonly subscribers = new Set<CopilotKitSubscriber>();
  private readonly aborts = new WeakMap<AbstractAgent, AbortController>();
  private renderVersion = 0;

  constructor(config: CopilotKitConfig) {
    this.runtimeUrl = config.runtimeUrl;
    this.configuredRenderToolCalls = [...(config.renderToolCalls ?? [])];
    this.configuredActivityRenderers = [...(config.renderActivityMessages ?? [])];
  }

  /**
   * The agent for a name and thread, made once and then shared.
   *
   * A threadless lookup and a threaded one for the same runtime agent resolve to one instance while
   * only one thread is in play, which is what makes `useAgent({ agentId })` inside a route see the
   * runs its chat started. A second thread is never written over the first: it gets its own agent,
   * because clobbering `threadId` on a running agent would send the next turn to the wrong place.
   */
  agentFor(lookup: AgentLookup): RuntimeAgent {
    const key = agentKey(lookup);
    const base = lookup.runtimeAgentId ?? lookup.agentId;
    const exact = this.agents.get(key);
    if (exact) return exact.agent;

    const shared = this.agents.get(base);
    if (shared) {
      const sameThread =
        shared.threadId === undefined ||
        lookup.threadId === undefined ||
        shared.threadId === lookup.threadId;
      if (sameThread) {
        if (lookup.threadId !== undefined && shared.threadId === undefined) {
          // Adopted: the threadless instance becomes this thread's, under both keys.
          shared.threadId = lookup.threadId;
          shared.agent.threadId = lookup.threadId;
          this.agents.set(key, shared);
        }
        return shared.agent;
      }
    }

    const created: RegisteredAgent = {
      key,
      runtimeAgentId: base,
      threadId: lookup.threadId,
      agent: new RuntimeAgent({
        runtimeUrl: this.runtimeUrl,
        runtimeAgentId: base,
        agentId: lookup.agentId,
        threadId: lookup.threadId,
      }),
    };
    this.agents.set(key, created);
    if (!this.agents.has(base)) this.agents.set(base, created);
    return created.agent;
  }

  // ---------------------------------------------------------------- tools

  /**
   * Offer one tool to the model, and hand back the way to take it away again.
   *
   * The wire description is built here rather than at each call, because `z.toJSONSchema` is the
   * only thing that knows what a zod 4 schema means and doing it once keeps every run's tool list
   * identical — a list that changes shape between runs changes what the model is allowed to do.
   */
  registerTool(tool: FrontendTool<Record<string, unknown>>): () => void {
    const key = toolKey(tool.name, tool.agentId);
    this.tools.set(key, { tool, agentId: tool.agentId });
    return () => {
      if (this.tools.get(key)?.tool === tool) this.tools.delete(key);
    };
  }

  /**
   * The tool the browser will run for this call, if it has a handler.
   *
   * A person's tool is registered here too — it has to be, or the model is never offered it — but
   * it has no handler, and a call to it must leave the run waiting rather than be answered here.
   */
  handlerFor(name: string, agentId: string | undefined): RegisteredTool | undefined {
    const registered =
      this.tools.get(toolKey(name, agentId)) ??
      this.tools.get(toolKey(name, undefined));
    return registered?.tool.handler ? registered : undefined;
  }

  /** The tool list one run is offered: everything available to this agent, never anything else. */
  toolsFor(agent: AbstractAgent): Tool[] {
    const agentId = agent.agentId;
    return [...this.tools.values()]
      .filter(
        (entry) =>
          entry.tool.available !== false &&
          (entry.agentId === undefined || entry.agentId === agentId),
      )
      .map((entry) => wireTool(entry.tool));
  }

  // -------------------------------------------------------------- renders

  get renderToolCalls(): readonly ReactToolCallRenderer[] {
    return [...this.configuredRenderToolCalls, ...this.hookRenderers.values()];
  }

  get renderActivityMessages(): readonly ReactActivityMessageRenderer<unknown>[] {
    return [
      ...this.configuredActivityRenderers,
      ...this.hookActivityRenderers.values(),
    ];
  }

  /** The counter a component subscribes to; it changes whenever a card is added or removed. */
  get renderRevision(): number {
    return this.renderVersion;
  }

  addHookRenderToolCall(renderer: ReactToolCallRenderer): () => void {
    const key = toolKey(renderer.name, renderer.agentId);
    this.hookRenderers.set(key, renderer);
    this.notifyRenderChange();
    return () => {
      if (this.hookRenderers.get(key) !== renderer) return;
      this.hookRenderers.delete(key);
      this.notifyRenderChange();
    };
  }

  addHookActivityRenderer(
    renderer: ReactActivityMessageRenderer<unknown>,
  ): () => void {
    const key = `${renderer.activityType}@${renderer.agentId ?? "*"}`;
    this.hookActivityRenderers.set(key, renderer);
    this.notifyRenderChange();
    return () => {
      if (this.hookActivityRenderers.get(key) !== renderer) return;
      this.hookActivityRenderers.delete(key);
      this.notifyRenderChange();
    };
  }

  /** The card for one tool call, narrowed to the agent that made it. */
  rendererFor(
    name: string,
    agentId: string | undefined,
  ): ReactToolCallRenderer | undefined {
    return (
      this.hookRenderers.get(toolKey(name, agentId)) ??
      this.hookRenderers.get(toolKey(name, undefined)) ??
      this.configuredRenderToolCalls.find(
        (renderer) =>
          renderer.name === name &&
          (renderer.agentId === undefined || renderer.agentId === agentId),
      )
    );
  }

  activityRendererFor(
    activityType: string,
    agentId: string | undefined,
  ): ReactActivityMessageRenderer<unknown> | undefined {
    const renderers = this.renderActivityMessages;
    return (
      renderers.find(
        (renderer) =>
          renderer.activityType === activityType &&
          (renderer.agentId === undefined || renderer.agentId === agentId),
      ) ?? renderers.find((renderer) => renderer.activityType === "*")
    );
  }

  subscribe(subscriber: CopilotKitSubscriber): CopilotKitSubscription {
    this.subscribers.add(subscriber);
    return {
      unsubscribe: () => {
        this.subscribers.delete(subscriber);
      },
    };
  }

  private notifyRenderChange(): void {
    this.renderVersion += 1;
    for (const subscriber of this.subscribers) {
      subscriber.onRenderToolCallsChanged?.({
        copilotkit: this,
        renderToolCalls: this.renderToolCalls,
      });
    }
  }

  // ------------------------------------------------------------------ runs

  /**
   * Run one turn, answering every browser-side tool call it leaves behind, until nothing is left
   * for this tab to answer.
   *
   * The loop is the whole point of a client tool: a run that calls one ends, its answer is appended
   * as a `tool` message, and the next run reads it. A card waiting on a person is not in this loop —
   * it is an interrupt, and `respondToInterrupt` is what continues that run.
   */
  async runAgent({ agent }: { agent: AbstractAgent }): Promise<void> {
    await agent.runAgent({ tools: this.toolsFor(agent) });
    await this.settleClientTools(agent);
  }

  /**
   * Attach to a thread this tab did not start: replay it, then follow its live run.
   *
   * Browser-side tools are settled afterwards for the same reason as a run's: a followed turn can
   * end on one, and nothing else would answer it.
   */
  async connectAgent({ agent }: { agent: AbstractAgent }): Promise<void> {
    await agent.connectAgent({ tools: this.toolsFor(agent) });
    await this.settleClientTools(agent);
  }

  /**
   * Stop a turn, including the part of it running here.
   *
   * Both halves matter: `abortRun` ends the stream, and the abort signal ends a browser-side handler
   * that is still working — otherwise its result would be appended to a conversation the person has
   * already left, and a follow-up run would start on its own.
   */
  stopAgent({ agent }: { agent: AbstractAgent }): void {
    this.abortFor(agent).abort();
    agent.abortRun();
  }

  /**
   * Answer an interrupt from a card, and continue the run it paused.
   *
   * Every open interrupt is answered in the same call, because a resume answers the whole set: the
   * one this card is about is `resolved`, and the rest are `cancelled` rather than left dangling for
   * a run that would then refuse to start.
   */
  async respondToInterrupt(
    agent: AbstractAgent,
    toolCallId: string,
    result: unknown,
  ): Promise<void> {
    const open = agent.pendingInterrupts;
    const target = open.find((interrupt) => interrupt.toolCallId === toolCallId);
    if (!target) {
      throw new Error("That request is no longer waiting for an answer.");
    }
    const resume = open.map((interrupt) =>
      interrupt.id === target.id
        ? { interruptId: interrupt.id, status: "resolved" as const, payload: result }
        : { interruptId: interrupt.id, status: "cancelled" as const },
    );
    await agent.runAgent({ tools: this.toolsFor(agent), resume });
    await this.settleClientTools(agent);
  }

  /** Yield to React before a follow-up run reads the context a handler just set. */
  async waitForPendingFrameworkUpdates(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  private abortFor(agent: AbstractAgent): AbortController {
    const existing = this.aborts.get(agent);
    if (existing) return existing;
    const controller = new AbortController();
    this.aborts.set(agent, controller);
    return controller;
  }

  private async settleClientTools(agent: AbstractAgent): Promise<void> {
    const signal = this.abortFor(agent).signal;
    for (let round = 0; round < MAX_CLIENT_TOOL_ROUNDS; round += 1) {
      if (signal.aborted) return;
      // A person owes an answer: the run stays paused, and a card is on screen for it.
      if (agent.pendingInterrupts.length > 0) return;
      const answerable = unansweredToolCalls(agent.messages).filter(
        (call) => this.handlerFor(call.function.name, agent.agentId) !== undefined,
      );
      if (answerable.length === 0) return;

      const answers = await Promise.all(
        answerable.map((call) => this.executeTool(agent, call, signal)),
      );
      if (signal.aborted) return;
      agent.addMessages(answers);
      await this.waitForPendingFrameworkUpdates();
      if (signal.aborted) return;
      await agent.runAgent({ tools: this.toolsFor(agent) });
    }
  }

  private async executeTool(
    agent: AbstractAgent,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<Message & { role: "tool"; toolCallId: string }> {
    const registered = this.handlerFor(call.function.name, agent.agentId);
    const context: FrontendToolHandlerContext = {
      signal,
      toolCall: call,
      agent,
    };
    let content: string;
    try {
      if (!registered?.tool.handler) {
        throw new Error(`No handler for ${call.function.name}.`);
      }
      const value = await registered.tool.handler(
        parseArguments(call.function.arguments),
        context,
      );
      content = stringifyResult(value);
    } catch (error) {
      // The model is told what went wrong rather than the turn dying: a refusal it can read is
      // something it can answer, which is the whole reason a tool runs in the browser.
      content = stringifyResult({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      id: `tool-${crypto.randomUUID()}`,
      role: "tool",
      toolCallId: call.id,
      content,
    };
  }
}

/** The registry key for one tool, scoped by the agent it was registered for. */
function toolKey(name: string, agentId: string | undefined): string {
  return `${name}@${agentId ?? "*"}`;
}

/** A tool as the model is told about it. */
function wireTool(tool: FrontendTool<Record<string, unknown>>): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: jsonSchemaOf(tool.parameters),
  };
}

/**
 * The JSON Schema for a zod schema.
 *
 * `io: "input"` because the model fills the arguments in, and a schema with a transform would
 * otherwise be described by its output — a shape the wire can never carry.
 */
function jsonSchemaOf(schema: ParametersSchema): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  > & { $schema?: string };
  void $schema;
  return rest;
}

/**
 * Every tool call in this conversation that nothing has answered yet.
 *
 * A call is answered by a `tool` message carrying its id. Anything else — a card, a note in the
 * transcript — leaves it unanswered, which is what a provider refuses to send again.
 */
export function unansweredToolCalls(messages: readonly Message[]): ToolCall[] {
  const answered = new Set(
    messages.flatMap((message) =>
      message.role === "tool" ? [message.toolCallId] : [],
    ),
  );
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).filter((call) => !answered.has(call.id))
      : [],
  );
}

/** The arguments a tool call carries, or an empty object while they do not parse. */
function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** What a handler returned, as the text a `tool` message carries. */
function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}
