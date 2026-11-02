import {
  type ComponentApi,
  GenericBinder,
  type InferredComponentApiSchemaType,
  type ResolveA2uiProps,
} from "@a2ui/web_core/v0_9";
import {
  type FC,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type {
  ComponentViewProps,
  ReactComponentImplementation,
  RendererProps,
} from "./types";

type ResolvedProps<Api extends ComponentApi> = ResolveA2uiProps<
  InferredComponentApiSchemaType<Api>
>;

/**
 * What a bad payload gets: the reason, in the open, instead of a component that half-draws.
 * A model-supplied interface is untrusted input; a schema mismatch is a message the person can
 * act on ("ask the assistant to correct this component"), not a blank hole in the conversation.
 */
function ComponentFailure({ name, detail }: { name: string; detail: string }) {
  return (
    <div role="alert">
      Unable to display {name}: {detail}. Ask the assistant to correct this
      component and try again.
    </div>
  );
}

/**
 * Wraps a component view into a catalog entry.
 *
 * The binder (`GenericBinder`, from `@a2ui/web_core`) is what turns raw payload properties into
 * ready-to-use props: data bindings are subscribed to and re-emitted on change, `action` becomes a
 * callable that resolves its context against the data model *at click time*, and `child`/`children`
 * become the ids to build. Subscribing through `useSyncExternalStore` is what makes all of that
 * drive React re-renders; the binder's snapshot is replaced (not mutated) on every change, so the
 * identity check React does is enough.
 */
export function createReactComponent<Api extends ComponentApi>(
  api: Api,
  View: FC<ComponentViewProps<Api>>,
): ReactComponentImplementation {
  function Bound({
    context,
    buildChild,
    properties,
  }: RendererProps & { properties: Record<string, unknown> }) {
    // biome-ignore lint/correctness/useExhaustiveDependencies: `properties` is the cache key rather than a read — an `updateComponents` message that replaces this component's props has to rebuild the binder, and the binder reads the props once.
    const binder = useMemo(
      () => new GenericBinder<ResolvedProps<Api>>(context, api.schema),
      [context, properties],
    );
    const props = useSyncExternalStore(
      useCallback(
        (onChange) => {
          const subscription = binder.subscribe(onChange);
          return () => subscription.unsubscribe();
        },
        [binder],
      ),
      useCallback(() => binder.snapshot, [binder]),
    );
    useEffect(
      () => () => {
        binder.dispose();
      },
      [binder],
    );
    return <View props={props} buildChild={buildChild} context={context} />;
  }

  function Validate(props: RendererProps) {
    const { context } = props;
    const properties = useSyncExternalStore(
      useCallback(
        (onChange) => {
          const subscription =
            context.componentModel.onUpdated.subscribe(onChange);
          return () => subscription.unsubscribe();
        },
        [context],
      ),
      useCallback(() => context.componentModel.properties, [context]),
    );
    const parsed = useMemo(
      () => api.schema.safeParse(properties),
      [properties],
    );
    if (!parsed.success) {
      return (
        <ComponentFailure
          name={api.name}
          detail={parsed.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "props"}: ${issue.message}`,
            )
            .join("; ")}
        />
      );
    }
    return <Bound {...props} properties={properties} />;
  }

  return { name: api.name, schema: api.schema, render: Validate };
}
