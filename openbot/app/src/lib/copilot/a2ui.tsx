import type { CopilotKitProviderProps } from "@copilotkit/react-core/v2";
import {
  basicCatalog,
  Catalog,
  type ReactComponentImplementation,
} from "./a2ui/index";

export type {
  A2UIClientEventMessage,
  ReactComponentImplementation,
  ServerToClientMessage,
} from "./a2ui/index";
export { A2UIProvider, A2UIRenderer, useA2UIActions } from "./a2ui/index";

/**
 * The public surface stays the same as when the SDK drew it: a Catalog built from the A2UI basic
 * catalog, each component wrapped so the app has one stable styling hook. The schemas, data
 * bindings and action handling are untouched — the wrapper only supplies the hook, because styling
 * a generated interface from the outside needs a marker the CSS can match.
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

const A2UI_OPTIONS = { catalog: OPENBOT_A2UI_CATALOG } satisfies NonNullable<
  CopilotKitProviderProps["a2ui"]
>;

/** Prop presence activates the SDK, so an unresolved or disabled capability must omit it. */
export function a2uiProviderOptions(enabled: boolean | undefined) {
  return enabled ? { a2ui: A2UI_OPTIONS } : {};
}
