/**
 * A2UI v0.9 in this repo: the message model, the catalog and a React renderer, on top of
 * `@a2ui/web_core`.
 *
 * `web_core` owns every piece of A2UI semantics — message processing, surfaces, the data model with
 * its JSON Pointer paths and subscriptions, and the generic binder that turns a component schema
 * plus a payload into resolved props. It ships no React renderer, so this module is that renderer
 * and nothing more.
 */
export { Catalog } from "@a2ui/web_core/v0_9";
export { basicCatalog } from "./catalog";
export {
  A2UIProvider,
  type A2UIProviderProps,
  useA2UIActions,
} from "./provider";
export { A2UIRenderer, type A2UIRendererProps } from "./renderer";
export type {
  A2UIClientEventMessage,
  ReactComponentImplementation,
  ServerToClientMessage,
} from "./types";
