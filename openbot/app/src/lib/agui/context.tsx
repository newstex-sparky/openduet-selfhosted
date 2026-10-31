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
import { CopilotKit } from "./core";
import type {
  ReactActivityMessageRenderer,
  ReactToolCallRenderer,
} from "./types";

export interface CopilotKitContextValue {
  /** The one registry this app runs on. */
  copilotkit: CopilotKit;
}

export const CopilotKitContext = createContext<CopilotKitContextValue | null>(
  null,
);

/** The registry, for a component that runs a turn or registers a tool. */
export function useCopilotKit(): CopilotKitContextValue {
  const value = useContext(CopilotKitContext);
  if (!value) {
    throw new Error(
      "useCopilotKit needs a CopilotKitProvider above it. See app/src/lib/copilot/provider.tsx.",
    );
  }
  return value;
}

export interface CopilotKitProviderProps {
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
export function CopilotKitProvider({
  runtimeUrl,
  children,
  renderToolCalls,
  renderActivityMessages,
}: CopilotKitProviderProps) {
  // The lists are read once. Rebuilding the registry for a new array would rebuild every agent.
  const lists = useRef({ renderToolCalls, renderActivityMessages });
  const copilotkit = useMemo(
    () =>
      new CopilotKit({
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
   * read `copilotkit.renderToolCalls` in their render body and hold no subscription — the vendor
   * provider re-rendered its subtree when a card arrived, and those surfaces were written against
   * that. This subscription is the re-render: a registration changes the registry's revision, this
   * provider renders again, and a card that mounted after a reply still draws. The value is read
   * for nothing, so it is not assigned.
   */
  const subscribe = useCallback(
    (onChange: () => void) =>
      copilotkit.subscribe({ onRenderToolCallsChanged: () => onChange() })
        .unsubscribe,
    [copilotkit],
  );
  useSyncExternalStore(subscribe, () => copilotkit.renderRevision);
  const value: CopilotKitContextValue = { copilotkit };
  return (
    <CopilotKitContext.Provider value={value}>
      {children}
    </CopilotKitContext.Provider>
  );
}

/** The agent and thread a nested surface binds to. */
export interface CopilotChatConfigurationValue {
  agentId: string;
  threadId?: string;
}

const ChatConfigurationContext =
  createContext<CopilotChatConfigurationValue | null>(null);

/**
 * Scope everything below to one agent and thread.
 *
 * `threadId` is optional because a surface that has not minted one yet still needs an agent; the
 * agent's own thread id is then whatever the runtime minted, and `useAgent` reads it off the
 * instance rather than off this value.
 */
export function CopilotChatConfigurationProvider({
  agentId,
  threadId,
  children,
}: CopilotChatConfigurationValue & { children: ReactNode }) {
  const value = useMemo(() => ({ agentId, threadId }), [agentId, threadId]);
  return (
    <ChatConfigurationContext.Provider value={value}>
      {children}
    </ChatConfigurationContext.Provider>
  );
}

/** The agent and thread this surface sits in, or null outside a chat. */
export function useCopilotChatConfiguration(): CopilotChatConfigurationValue | null {
  return useContext(ChatConfigurationContext);
}

/** The agent a tool registered here belongs to, for scoping its card. */
export function useDefaultAgentId(): string | undefined {
  return useContext(ChatConfigurationContext)?.agentId;
}
