import { type Catalog, MessageProcessor } from "@a2ui/web_core/v0_9";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  A2UIActions,
  A2UIClientEventMessage,
  OnAction,
  ReactComponentImplementation,
} from "./types";

export type A2UIProviderProps = {
  /** The components this renderer can draw. A surface names it by id in `createSurface`. */
  catalog: Catalog<ReactComponentImplementation>;
  /** Receives every user action, already shaped as the runtime's `userAction` event. */
  onAction?: OnAction;
  children?: ReactNode;
};

/**
 * Two contexts on purpose. The actions never change identity, so components that only *send*
 * (`processMessages`) never re-render; the version does change, and only the renderer that has to
 * look a surface up again subscribes to it.
 */
const ActionsContext = createContext<A2UIActions | null>(null);
const VersionContext = createContext(0);

/**
 * Owns the A2UI v0.9 message processor for one catalog.
 *
 * All the state — surfaces, components, the data model — lives in `@a2ui/web_core`'s models. This
 * component only keeps them across renders, turns dispatched actions into the runtime's event
 * shape, and bumps a version so React re-reads the surface table after each batch.
 */
export function A2UIProvider({
  catalog,
  onAction,
  children,
}: A2UIProviderProps) {
  const onActionRef = useRef(onAction);
  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  const processorRef =
    useRef<MessageProcessor<ReactComponentImplementation> | null>(null);
  if (!processorRef.current) {
    // Built once: the processor is the state. Rebuilding it on a catalog prop that merely
    // changed identity would throw away every surface that is already on screen.
    processorRef.current = new MessageProcessor<ReactComponentImplementation>(
      [catalog],
      (action) => {
        const handler = onActionRef.current;
        if (!handler) return;
        const message: A2UIClientEventMessage = {
          userAction: {
            name: action.name,
            surfaceId: action.surfaceId,
            sourceComponentId: action.sourceComponentId,
            context: action.context,
            timestamp: action.timestamp,
          },
        };
        void handler(message);
      },
    );
  }
  const processor = processorRef.current;
  const [version, setVersion] = useState(0);

  const actions = useMemo<A2UIActions>(
    () => ({
      processMessages: (messages) => {
        try {
          processor.processMessages(messages);
        } catch (error) {
          // A malformed batch must not take the conversation down with it: the surface keeps
          // whatever it has drawn and the next batch can still land.
          console.error("[a2ui] rejected a message batch", error);
          return;
        }
        setVersion((current) => current + 1);
      },
      getSurface: (surfaceId) => processor.model.getSurface(surfaceId),
    }),
    [processor],
  );

  return (
    <ActionsContext.Provider value={actions}>
      <VersionContext.Provider value={version}>
        {children}
      </VersionContext.Provider>
    </ActionsContext.Provider>
  );
}

/** The stable actions. Safe to use in an effect dependency list. */
export function useA2UIActions(): A2UIActions {
  const actions = useContext(ActionsContext);
  if (!actions) {
    throw new Error("useA2UIActions must be used within an A2UIProvider");
  }
  return actions;
}

/** How many batches have landed. Reading it is how the renderer re-reads the surface table. */
export function useSurfaceVersion(): number {
  return useContext(VersionContext);
}
