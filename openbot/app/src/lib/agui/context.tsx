/**
 * What a component reaches for to talk to the runtime, and what scopes a chat to one conversation.
 *
 * Two contexts rather than one: the registry is app-wide and never changes identity, while the
 * agent and thread a surface binds to change with the screen. A card registered inside a channel
 * must draw on that channel's runs, and the only thing that says which runs those are is the
 * configuration around it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AgentRuntime } from "./core";
import type {
  ReactActivityMessageRenderer,
  ReactToolCallRenderer,
} from "./types";

export interface AgentContextValue {
  /** The one registry this app runs on. */
  agentRuntime: AgentRuntime;
}

export const AgentContext = createContext<AgentContextValue | null>(
  null,
);

/** The registry, for a component that runs a turn or registers a tool. */
export function useAgentRuntime(): AgentContextValue {
  const value = useContext(AgentContext);
  if (!value) {
    throw new Error(
      "useAgentRuntime needs a AgentProvider above it. See app/src/lib/chat/provider.tsx.",
    );
  }
  return value;
}

export interface AgentProviderProps {
  /**
   * The runtime's base URL, relative like every other call in the app so the dev proxy and a
   * single-origin deployment both work. Requests carry the session cookie; see `RuntimeAgent`.
   */
  runtimeUrl: string;
  children: ReactNode;
  renderToolCalls?: ReactToolCallRenderer[];
  renderActivityMessages?: ReactActivityMessageRenderer<unknown>[];
}

/**
 * The client, wrapped once for the whole authenticated app.
 *
 * The registry is made once per provider instance and never rebuilt: it owns the agents, and an
 * agent rebuilt on a render is an agent that has forgotten the conversation it was in.
 */
export function AgentProvider({
  runtimeUrl,
  children,
  renderToolCalls,
  renderActivityMessages,
}: AgentProviderProps) {
  // The lists are read once. Rebuilding the registry for a new array would rebuild every agent.
  const lists = useRef({ renderToolCalls, renderActivityMessages });
  const agentRuntime = useMemo(
    () =>
      new AgentRuntime({
        runtimeUrl,
        renderToolCalls: lists.current.renderToolCalls,
        renderActivityMessages: lists.current.renderActivityMessages,
      }),
    [runtimeUrl],
  );
  /*
   * A CARD REGISTERED LATER MUST REACH A CONSUMER THAT NEVER SUBSCRIBED.
   *
   * `useRenderToolCall` and `useRenderTool` watch the registry themselves, but plenty of surfaces
   * read `agentRuntime.renderToolCalls` in their render body and hold no subscription — the vendor
   * provider re-rendered its subtree when a card arrived, and those surfaces were written against
   * that. This subscription is the re-render: a registration changes the registry's revision, this
   * provider renders again, and a card that mounted after a reply still draws. The value is read
   * for nothing, so it is not assigned.
   */
  const subscribe = useCallback(
    (onChange: () => void) =>
      agentRuntime.subscribe({ onRenderToolCallsChanged: () => onChange() })
        .unsubscribe,
    [agentRuntime],
  );
  useSyncExternalStore(subscribe, () => agentRuntime.renderRevision);
  const value: AgentContextValue = { agentRuntime };
  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  );
}

/** The agent and thread a nested surface binds to. */
export interface ChatShellConfigurationValue {
  agentId: string;
  threadId?: string;
}

const ChatConfigurationContext =
  createContext<ChatShellConfigurationValue | null>(null);

/**
 * Scope everything below to one agent and thread.
 *
 * `threadId` is optional because a surface that has not minted one yet still needs an agent; the
 * agent's own thread id is then whatever the runtime minted, and `useAgent` reads it off the
 * instance rather than off this value.
 */
export function ChatConfigurationProvider({
  agentId,
  threadId,
  children,
}: ChatShellConfigurationValue & { children: ReactNode }) {
  const value = useMemo(() => ({ agentId, threadId }), [agentId, threadId]);
  return (
    <ChatConfigurationContext.Provider value={value}>
      {children}
    </ChatConfigurationContext.Provider>
  );
}

/** The agent and thread this surface sits in, or null outside a chat. */
export function useChatConfiguration(): ChatShellConfigurationValue | null {
  return useContext(ChatConfigurationContext);
}

/** The agent a tool registered here belongs to, for scoping its card. */
export function useDefaultAgentId(): string | undefined {
  return useContext(ChatConfigurationContext)?.agentId;
}
