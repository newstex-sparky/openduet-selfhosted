import { ComponentContext, type SurfaceModel } from "@a2ui/web_core/v0_9";
import {
  memo,
  type ReactNode,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useA2UIActions, useSurfaceVersion } from "./provider";
import type { BuildChild, ReactComponentImplementation } from "./types";

/**
 * The id every surface is drawn from. A2UI v0.9 gives `createSurface` no way to name its own entry
 * point, so the root id is fixed by the renderer, not by the payload.
 */
const ROOT_COMPONENT_ID = "root";

type Surface = SurfaceModel<ReactComponentImplementation>;

type NodeProps = { surface: Surface; id: string; basePath?: string };

/**
 * Looks one component up and draws it, or nothing at all while it is still on its way.
 *
 * Subscribing to `onCreated`/`onDeleted` is what lets a child arrive in a later message than its
 * parent: the surface is already drawn, so the placeholder has to notice the component appearing.
 */
const ComponentNode = memo(function ComponentNode({
  surface,
  id,
  basePath,
}: NodeProps) {
  const componentModel = useSyncExternalStore(
    useCallback(
      (onChange) => {
        const created = surface.componentsModel.onCreated.subscribe(
          (component) => {
            if (component.id === id) onChange();
          },
        );
        const deleted = surface.componentsModel.onDeleted.subscribe(
          (deletedId) => {
            if (deletedId === id) onChange();
          },
        );
        return () => {
          created.unsubscribe();
          deleted.unsubscribe();
        };
      },
      [surface, id],
    ),
    useCallback(() => surface.componentsModel.get(id), [surface, id]),
  );

  if (!componentModel) return null;
  const implementation = surface.catalog.components.get(componentModel.type);
  if (!implementation) {
    return <div role="alert">Unsupported component: {componentModel.type}</div>;
  }
  return (
    <ResolvedNode
      surface={surface}
      id={id}
      basePath={basePath}
      implementation={implementation}
    />
  );
});

const ResolvedNode = memo(function ResolvedNode({
  surface,
  id,
  basePath,
  implementation,
}: NodeProps & { implementation: ReactComponentImplementation }) {
  // One context per (component, data path). Its data context is the scope every `{ path }` prop in
  // this component resolves against, so it must not be rebuilt on unrelated re-renders.
  const context = useMemo(
    () => new ComponentContext(surface, id, basePath),
    [surface, id, basePath],
  );
  const buildChild: BuildChild = useCallback(
    (childId, childBasePath) => (
      <ComponentNode
        surface={surface}
        id={childId}
        basePath={childBasePath ?? context.dataContext.path}
      />
    ),
    [surface, context],
  );
  const Render = implementation.render;
  return <Render context={context} buildChild={buildChild} />;
});

export type A2UIRendererProps = {
  /** The surface to draw. Nothing renders until a `createSurface` for this id has arrived. */
  surfaceId: string;
  className?: string;
  fallback?: ReactNode;
};

/** Draws one A2UI surface from the messages its provider has processed. */
export const A2UIRenderer = memo(function A2UIRenderer({
  surfaceId,
  className,
  fallback = null,
}: A2UIRendererProps) {
  // Reading the version is what re-runs this lookup after a batch lands.
  useSurfaceVersion();
  const surface = useA2UIActions().getSurface(surfaceId);
  if (!surface) return <>{fallback}</>;
  return (
    <div className={className} data-surface-id={surfaceId}>
      <ComponentNode surface={surface} id={ROOT_COMPONENT_ID} basePath="/" />
    </div>
  );
});
