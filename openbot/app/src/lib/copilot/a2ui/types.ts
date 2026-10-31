import type {
  ComponentApi,
  ComponentContext,
  InferredComponentApiSchemaType,
  ResolveA2uiProps,
  SurfaceModel,
} from "@a2ui/web_core/v0_9";
import type { FC, ReactNode } from "react";

/**
 * The React-side shape of one catalog entry, mirroring the A2UI React binding:
 * a schema (so the data binder knows which props are data bindings, actions or
 * structural children) plus the component that draws it.
 */
export interface ReactComponentImplementation extends ComponentApi {
  render: FC<RendererProps>;
}

/** Everything a component gets from the renderer: its resolved context and a child factory. */
export type RendererProps = {
  context: ComponentContext;
  buildChild: BuildChild;
};

/**
 * Draws a child component by id. `basePath` scopes the child's data bindings, which is how a
 * `List` gives each row its own slice of the data model.
 */
export type BuildChild = (id: string, basePath?: string) => ReactNode;

/** A resolved structural child: the binder hands these back for `children`/`child` props. */
export type ChildRef = { id: string; basePath?: string };

/** What a component view is called with: props resolved from the payload, and the two builders. */
export type ComponentViewProps<Api extends ComponentApi> = {
  props: ResolveA2uiProps<InferredComponentApiSchemaType<Api>>;
  buildChild: BuildChild;
  context: ComponentContext;
};

/** One node of an `updateComponents` payload. Component-specific props ride along unresolved. */
export type A2uiComponentNode = {
  component: string;
  id?: string;
  weight?: number;
  [key: string]: unknown;
};

/**
 * A v0.9 server-to-client message.
 *
 * Deliberately the union of the four message shapes rather than `Record<string, unknown>`: the
 * processor switches on which key is present, so keeping them distinct is what makes an unknown
 * message a type error instead of a silent no-op.
 */
export type ServerToClientMessage =
  | {
      version: "v0.9";
      createSurface: {
        surfaceId: string;
        catalogId: string;
        theme?: unknown;
        sendDataModel?: boolean;
      };
    }
  | {
      version: "v0.9";
      updateComponents: {
        surfaceId: string;
        components: A2uiComponentNode[];
      };
    }
  | {
      version: "v0.9";
      updateDataModel: {
        surfaceId: string;
        path?: string;
        value?: unknown;
      };
    }
  | { version: "v0.9"; deleteSurface: { surfaceId: string } };

/**
 * The event a user action is sent upstream as: the runtime's A2UI middleware reads `userAction`
 * and forwards it to the agent as a tool call, so the shape is fixed by the protocol.
 */
export interface A2UIClientEventMessage {
  userAction?: {
    name: string;
    surfaceId: string;
    sourceComponentId?: string;
    context?: Record<string, unknown>;
    timestamp?: string;
  };
}

export type OnAction = (
  message: A2UIClientEventMessage,
) => void | Promise<void>;

/** The stable half of the provider context: these never change identity, so they never re-render. */
export type A2UIActions = {
  processMessages: (messages: ServerToClientMessage[]) => void;
  getSurface: (
    surfaceId: string,
  ) => SurfaceModel<ReactComponentImplementation> | undefined;
};
