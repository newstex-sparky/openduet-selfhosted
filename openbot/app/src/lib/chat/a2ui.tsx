import {
  type CopilotKitProviderProps,
  useCopilotChatConfiguration,
  useCopilotKit,
} from "@/lib/agui";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  A2UIProvider,
  A2UIRenderer,
  basicCatalog,
  Catalog,
  type A2UIClientEventMessage,
  type ReactComponentImplementation,
  type ServerToClientMessage,
  useA2UIActions,
} from "./a2ui/index";

export {
  A2UIProvider,
  A2UIRenderer,
  useA2UIActions,
} from "./a2ui/index";
export type {
  A2UIClientEventMessage,
  ReactComponentImplementation,
  ServerToClientMessage,
} from "./a2ui/index";

/**
 * The catalog a Bot's surface is drawn from: the A2UI basic catalog, each component wrapped so the
 * app has one stable styling hook. The schemas, data bindings and action handling are untouched —
 * the wrapper only supplies the hook, because styling a generated interface from the outside needs
 * a marker the CSS can match.
 */
function branded(
  component: ReactComponentImplementation,
): ReactComponentImplementation {
  const Render = component.render;
  return {
    ...component,
    render: (props) => (
      <div data-openbot-a2ui={component.name} style={{ display: "contents" }}>
        <Render {...props} />
      </div>
    ),
  };
}

export const OPENBOT_A2UI_CATALOG = new Catalog(
  basicCatalog.id,
  Array.from(basicCatalog.components.values(), branded),
  Array.from(basicCatalog.functions.values()),
  basicCatalog.themeSchema,
);

/** The activity type the runtime's A2UI middleware emits a surface as. */
const A2UI_ACTIVITY = "a2ui-surface";

/** What one A2UI activity carries: the v0.9 messages that build or update a surface. */
type A2UIActivityContent = {
  a2ui_operations?: ServerToClientMessage[];
  surfaceId?: string;
};

/** A stable empty list, so a message with no operations does not re-run the ingest effect. */
const NO_OPERATIONS: ServerToClientMessage[] = [];

/**
 * The surface an activity is about.
 *
 * A batch names its surface in the operation that creates or updates it and nowhere else, so the id
 * is read off the batch rather than guessed from the transcript.
 */
function surfaceIdOf(
  content: A2UIActivityContent,
  operations: readonly ServerToClientMessage[],
): string | undefined {
  if (typeof content.surfaceId === "string") return content.surfaceId;
  for (const operation of operations) {
    if ("createSurface" in operation) return operation.createSurface.surfaceId;
    if ("updateComponents" in operation)
      return operation.updateComponents.surfaceId;
    if ("updateDataModel" in operation)
      return operation.updateDataModel.surfaceId;
    if ("deleteSurface" in operation) return operation.deleteSurface.surfaceId;
  }
  return undefined;
}

/** Feeds one batch into the provider's processor, once per batch. */
function Ingest({
  operations,
}: {
  operations: readonly ServerToClientMessage[];
}) {
  const { processMessages } = useA2UIActions();
  const done = useRef<readonly ServerToClientMessage[] | null>(null);
  useEffect(() => {
    if (done.current === operations) return;
    done.current = operations;
    if (operations.length > 0) processMessages([...operations]);
  }, [operations, processMessages]);
  return null;
}

/**
 * One surface a Bot wrote, and the way a person's click continues the conversation.
 *
 * The click answers with the values the person edited, because the binder resolves the action's
 * data paths against the surface's model at the moment it fires. It rides the run as
 * `forwardedProps.a2uiAction` and nothing else: the server reads it once, and a later turn must not
 * inherit a click that belongs to the turn somebody made it in.
 */
function A2UISurface({
  content,
  catalog,
}: {
  content: A2UIActivityContent;
  catalog: Catalog<ReactComponentImplementation>;
}) {
  const { copilotkit } = useCopilotKit();
  const configuration = useCopilotChatConfiguration();
  const operations = content.a2ui_operations ?? NO_OPERATIONS;
  const surfaceId = useMemo(
    () => surfaceIdOf(content, operations),
    [content, operations],
  );

  const onAction = useCallback(
    async (message: A2UIClientEventMessage) => {
      if (!configuration) return;
      const agent = copilotkit.agentFor({
        agentId: configuration.agentId,
        runtimeAgentId: configuration.agentId,
        threadId: configuration.threadId,
      });
      await copilotkit.runAgent({
        agent,
        forwardedProps: { a2uiAction: message },
      });
    },
    [configuration, copilotkit],
  );

  return (
    <A2UIProvider catalog={catalog} onAction={onAction}>
      <Ingest operations={operations} />
      <A2UIRenderer surfaceId={surfaceId ?? ""} />
    </A2UIProvider>
  );
}

/** Draws A2UI activities with the app's own renderer, over `@a2ui/web_core`. */
export function a2uiActivityRenderers(
  enabled: boolean | undefined,
): NonNullable<CopilotKitProviderProps["renderActivityMessages"]> {
  if (!enabled) return [];
  return [
    {
      activityType: A2UI_ACTIVITY,
      render: ({ content }: { content: unknown }) => (
        <A2UISurface
          catalog={OPENBOT_A2UI_CATALOG}
          content={(content ?? {}) as A2UIActivityContent}
        />
      ),
    },
  ];
}

/**
 * Provider props for a deployment that can draw A2UI surfaces.
 *
 * A deployment with the server half off and the browser half on has Bots writing surfaces nothing
 * draws, so this reads the one capability answer as well; see `DeploymentCapabilities.generativeUi`.
 */
export function a2uiProviderOptions(enabled: boolean | undefined) {
  return enabled
    ? { renderActivityMessages: a2uiActivityRenderers(enabled) }
    : {};
}
