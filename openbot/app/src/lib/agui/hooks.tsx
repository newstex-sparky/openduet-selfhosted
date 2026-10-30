/**
 * The hooks a surface uses to bind a conversation and register what draws a tool call.
 *
 * Every registration here reads its component's latest render through a ref instead of being
 * re-registered when a closure changes. That is a deliberate difference from the vendor SDK this
 * replaces, which registered once and kept the first render's handler for ever: a handler closing
 * over a query that had not loaded yet kept answering with the answer it had at mount.
 */
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useCopilotChatConfiguration,
  useCopilotKit,
  useDefaultAgentId,
} from "./context";
import type { CopilotKit } from "./core";
import type { RuntimeAgent } from "./agent";
import {
  ToolCallStatus,
  UseAgentUpdate,
  type ActivityMessage,
  type FrontendTool,
  type FrontendToolHandlerContext,
  type HumanInTheLoopRenderProps,
  type ParametersOf,
  type ParametersSchema,
  type ReactActivityMessageRenderer,
  type ReactToolCallRenderer,
  type ToolCall,
  type ToolRenderProps,
} from "./types";

export interface UseAgentProps {
  /** The name to bind. Inside a chat configuration this is the same name the chat uses. */
  agentId: string;
  /** The agent at the runtime to address, when it differs from the browser-side name. */
  runtimeAgentId?: string;
  /** The thread to run in. Omitted, the surrounding chat configuration's thread is used. */
  threadId?: string;
  /** What about this agent re-renders the caller. Defaults to messages and run status. */
  updates?: UseAgentUpdate[];
  /** Accepted for call-site compatibility. Re-renders are left to React's batching. */
  throttleMs?: number;
}

export interface UseAgentResult {
  agent: RuntimeAgent;
  /**
   * Whether there is an agent to send to.
   *
   * True as soon as one exists, which is synchronous here: there is no discovery round-trip
   * between this tab and its own server, so "not ready yet" is not a state this client has. A run
   * that cannot reach the runtime fails at the run, where the failure is reported.
   */
  isReady: boolean;
}

const DEFAULT_UPDATES: UseAgentUpdate[] = [
  UseAgentUpdate.OnMessagesChanged,
  UseAgentUpdate.OnRunStatusChanged,
];

/**
 * A counter that moves when an agent's messages, state or run status change.
 *
 * React needs a value it can compare: `isRunning` alone misses a run that started and finished
 * between two renders, and an agent's identity never changes.
 */
const revisions = new WeakMap<RuntimeAgent, number>();
const listeners = new WeakMap<RuntimeAgent, Set<() => void>>();

function revisionOf(agent: RuntimeAgent): number {
  return revisions.get(agent) ?? 0;
}

function bump(agent: RuntimeAgent): void {
  revisions.set(agent, revisionOf(agent) + 1);
  for (const listener of listeners.get(agent) ?? []) listener();
}

/**
 * Bind one agent, and re-render when what it was asked for changes.
 *
 * The thread comes from the surrounding chat configuration when the caller does not name one, which
 * is what makes `useAgent({ agentId })` in a route watch the runs its `CopilotChat` starts rather
 * than a second, empty agent under the same name.
 */
export function useAgent({
  agentId,
  runtimeAgentId,
  threadId,
  updates = DEFAULT_UPDATES,
}: UseAgentProps): UseAgentResult {
  const { copilotkit } = useCopilotKit();
  const configuration = useCopilotChatConfiguration();
  const agent = copilotkit.agentFor({
    agentId,
    runtimeAgentId: runtimeAgentId ?? agentId,
    threadId: threadId ?? configuration?.threadId,
  });
  const wanted = updates.join(",");
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToAgent(agent, wanted, onChange),
    [agent, wanted],
  );
  // Subscribing is the effect; the value returned is the revision React compares.
  useSyncExternalStore(subscribe, () => revisionOf(agent));
  return { agent, isReady: true };
}

function subscribeToAgent(
  agent: RuntimeAgent,
  updates: string,
  onChange: () => void,
): () => void {
  const wanted = new Set(updates.split(","));
  const bumpThis = () => bump(agent);
  const subscription = agent.subscribe({
    onMessagesChanged: wanted.has(UseAgentUpdate.OnMessagesChanged)
      ? bumpThis
      : undefined,
    onStateChanged: wanted.has(UseAgentUpdate.OnStateChanged)
      ? bumpThis
      : undefined,
    onRunInitialized: wanted.has(UseAgentUpdate.OnRunStatusChanged)
      ? bumpThis
      : undefined,
    onRunFinalized: wanted.has(UseAgentUpdate.OnRunStatusChanged)
      ? bumpThis
      : undefined,
    onRunFailed: wanted.has(UseAgentUpdate.OnRunStatusChanged)
      ? bumpThis
      : undefined,
  });
  const registered = listeners.get(agent) ?? new Set<() => void>();
  registered.add(onChange);
  listeners.set(agent, registered);
  return () => {
    subscription.unsubscribe();
    registered.delete(onChange);
  };
}

/** Everything a tool registration may carry, with its arguments named by its schema. */
export interface FrontendToolConfig<S extends ParametersSchema> {
  name: string;
  description: string;
  parameters: S;
  /** Hide it from the model without unmounting the hook. */
  available?: boolean;
  /** Constrain it to one agent. Defaults to the chat this hook sits in. */
  agentId?: string;
  handler?: (
    args: ParametersOf<S>,
    context: FrontendToolHandlerContext,
  ) => unknown | Promise<unknown>;
  /** Draw its calls with this card. */
  render?: (props: ToolRenderProps<ParametersOf<S>>) => ReactNode;
}

/**
 * Register a tool the browser answers.
 *
 * `deps` is accepted for call-site compatibility and is not needed: the registration is keyed by
 * name and agent, and every field it publishes is read from the latest render, so there is nothing
 * left to refresh.
 */
export function useFrontendTool<S extends ParametersSchema>(
  tool: FrontendToolConfig<S>,
  deps?: readonly unknown[],
): void {
  void deps;
  useRegisterTool(tool);
}

/** Register a tool that stops the run and puts a card in front of a person. */
export function useHumanInTheLoop<S extends ParametersSchema>(
  tool: Omit<FrontendToolConfig<S>, "handler" | "render"> & {
    render: (props: HumanInTheLoopRenderProps<ParametersOf<S>>) => ReactNode;
  },
  deps?: readonly unknown[],
): void {
  void deps;
  useRegisterTool(tool, true);
}

/**
 * The shared half of both tool hooks: one registry entry, read live.
 *
 * `humanInTheLoop` is the difference that matters — a person's tool has no handler, so the run
 * waits for it instead of this tab answering on the person's behalf.
 */
function useRegisterTool<S extends ParametersSchema>(
  tool: Omit<FrontendToolConfig<S>, "render"> & {
    /**
     * Either card shape. `never` in the parameter position is what lets one field accept both
     * without the two unions collapsing into each other.
     */
    render?: (props: never) => ReactNode;
  },
  humanInTheLoop = false,
): void {
  const { copilotkit } = useCopilotKit();
  const configuredAgentId = useDefaultAgentId();
  const agentId = tool.agentId ?? configuredAgentId;
  const latest = useRef(tool);
  latest.current = tool;
  const { name } = tool;

  /*
   * KEYED ON THE NAME, NOT ON THE SCHEMA. A caller may build its `z.object` inline — several here
   * do — so the schema is a new object every render; keying the effect on it would unregister and
   * re-register on every render, and each registration re-renders the surfaces watching the
   * registry. That is an infinite loop, and it is how this hook first failed its own test.
   */
  useEffect(() => {
    const registered: FrontendTool<Record<string, unknown>> = {
      name,
      agentId,
      get description() {
        return latest.current.description;
      },
      get parameters() {
        return latest.current.parameters;
      },
      get available() {
        return latest.current.available;
      },
      get handler() {
        // A person's tool is not answered here, whatever else the object says.
        if (humanInTheLoop) return undefined;
        return (latest.current as FrontendToolConfig<S>).handler as unknown as
          | ((
              args: Record<string, unknown>,
              context: FrontendToolHandlerContext,
            ) => unknown | Promise<unknown>)
          | undefined;
      },
    };
    const unregister = copilotkit.registerTool(registered);

    const draw = tool.render as ((props: unknown) => ReactNode) | undefined;
    const undraw = draw
      ? copilotkit.addHookRenderToolCall({
          name,
          agentId,
          get parameters() {
            return latest.current.parameters;
          },
          humanInTheLoop,
          description: tool.description,
          render: (props) => draw(props),
        })
      : () => {};

    return () => {
      unregister();
      undraw();
    };
  }, [copilotkit, name, agentId, humanInTheLoop]);
}

/**
 * Draw one tool's calls with this card.
 *
 * The renderer is not a tool: the server owns the tool and runs it. This only says what a person
 * sees while it runs and after it answers.
 */
export function useRenderTool<S extends ParametersSchema>(
  config: {
    name: string;
    parameters: S;
    agentId?: string;
    render: (props: ToolRenderProps<ParametersOf<S>>) => ReactNode;
  },
  deps?: readonly unknown[],
): void {
  void deps;
  const { copilotkit } = useCopilotKit();
  const configuredAgentId = useDefaultAgentId();
  const agentId = config.agentId ?? configuredAgentId;
  const latest = useRef(config);
  latest.current = config;
  const { name } = config;

  // Keyed on the name for the reason `useRegisterTool` records: an inline schema is a new object
  // every render, and re-registering on it re-renders the watchers, which re-renders this.
  useEffect(() => {
    return copilotkit.addHookRenderToolCall({
      name,
      agentId,
      get parameters() {
        return latest.current.parameters;
      },
      render: (props) => latest.current.render(props as never),
    });
  }, [copilotkit, name, agentId]);
}

/**
 * The function a transcript draws a tool call with.
 *
 * Its identity changes when a card is registered, which is what lets a transcript already on screen
 * draw a card registered a moment later — a Bot's reply can arrive before the component that
 * authored it has mounted.
 */
export function useRenderToolCall(): (props: {
  toolCall: ToolCall;
  /**
   * The `tool` message that answered the call, when one has arrived.
   *
   * Only `content` is read here; the field accepts the whole protocol message because that is what
   * a transcript holds and re-shaping it at every call site would be a copy of a value nothing
   * needs copied.
   */
  toolMessage?: { content: string } & Record<string, unknown>;
}) => ReactNode | null {
  const { copilotkit } = useCopilotKit();
  const configuredAgentId = useDefaultAgentId();
  useRenderWatch(copilotkit);

  return useCallback(
    ({ toolCall, toolMessage }) => {
      const renderer = copilotkit.rendererFor(
        toolCall.function.name,
        configuredAgentId,
      );
      if (!renderer) return null;
      const parameters = parseToolArguments(toolCall.function.arguments);
      const answered = toolMessage !== undefined;
      const props: Record<string, unknown> = {
        name: toolCall.function.name,
        toolCallId: toolCall.id,
        args: parameters,
        parameters,
        status: answered ? ToolCallStatus.Complete : ToolCallStatus.Executing,
        result: answered ? toolMessage.content : undefined,
        respond:
          answered || !renderer.humanInTheLoop
            ? undefined
            : respondFor(copilotkit, toolCall.id, configuredAgentId),
        ...(renderer.humanInTheLoop
          ? { description: renderer.description ?? "" }
          : {}),
      };
      return createElement(
        renderer.render as unknown as (p: Record<string, unknown>) => ReactNode,
        props,
      );
    },
    [copilotkit, configuredAgentId],
  );
}

/**
 * The way a person's answer continues the run, when there is something waiting for it.
 *
 * Resolved at draw time rather than at registration: the interrupt this answers does not exist
 * until the server pauses, and the agent that owns it is whichever one the call belongs to.
 */
function respondFor(
  copilotkit: CopilotKit,
  toolCallId: string,
  agentId: string | undefined,
): ((result: unknown) => Promise<void>) | undefined {
  if (!agentId) return undefined;
  const agent = copilotkit.agentFor({ agentId, runtimeAgentId: agentId });
  const waiting = agent.pendingInterrupts.some(
    (interrupt) => interrupt.toolCallId === toolCallId,
  );
  if (!waiting) return undefined;
  return (result: unknown) =>
    copilotkit.respondToInterrupt(agent, toolCallId, result);
}

/** The function a transcript draws an activity message with. */
export function useRenderActivityMessage(): {
  renderActivityMessage: (message: ActivityMessage) => ReactNode | null;
} {
  const { copilotkit } = useCopilotKit();
  const configuredAgentId = useDefaultAgentId();
  useRenderWatch(copilotkit);

  const renderActivityMessage = useCallback(
    (message: ActivityMessage) => {
      const renderer = copilotkit.activityRendererFor(
        message.activityType,
        configuredAgentId,
      );
      if (!renderer) return null;
      return createElement(
        renderer.render as unknown as (p: Record<string, unknown>) => ReactNode,
        {
          activityType: message.activityType,
          content: message.content,
          message,
          agent: configuredAgentId
            ? copilotkit.agentFor({
                agentId: configuredAgentId,
                runtimeAgentId: configuredAgentId,
              })
            : undefined,
        },
      );
    },
    [copilotkit, configuredAgentId],
  );

  return { renderActivityMessage };
}

/** Re-render when a card is added or removed, so an open transcript picks it up. */
function useRenderWatch(copilotkit: CopilotKit): void {
  const subscribe = useCallback(
    (onChange: () => void) =>
      copilotkit.subscribe({ onRenderToolCallsChanged: () => onChange() })
        .unsubscribe,
    [copilotkit],
  );
  useSyncExternalStore(subscribe, () => copilotkit.renderRevision);
}

/** Register an activity type's drawing. */
export function useRenderActivity<TContent>(renderer: {
  activityType: string;
  agentId?: string;
  render: (props: {
    activityType: string;
    content: TContent;
    message: ActivityMessage;
  }) => ReactNode;
}): void {
  const { copilotkit } = useCopilotKit();
  const configuredAgentId = useDefaultAgentId();
  const agentId = renderer.agentId ?? configuredAgentId;
  const latest = useRef(renderer);
  latest.current = renderer;
  const { activityType } = renderer;

  useEffect(() => {
    const registered: ReactActivityMessageRenderer<unknown> = {
      activityType,
      agentId,
      render: (props) =>
        latest.current.render(props as unknown as {
          activityType: string;
          content: TContent;
          message: ActivityMessage;
        }),
    };
    return copilotkit.addHookActivityRenderer(registered);
  }, [copilotkit, activityType, agentId]);
}

/** A tool call's arguments, or an empty object while they are still arriving. */
export function parseToolArguments(raw: string): Record<string, unknown> {
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
