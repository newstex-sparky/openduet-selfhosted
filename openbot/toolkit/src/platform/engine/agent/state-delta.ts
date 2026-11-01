import { type BaseEvent, EventType } from "@ag-ui/client";

/**
 * JSON Pointer reads, JSON Patch application and state-event normalization for a built-in Bot's
 * run.
 *
 * Ported from the CopilotKit runtime package, 1.77.0 (`dist/agent/state-delta.mjs`, MIT), which this
 * repository stops depending on in Phase 6. The rules are the vendor's, unchanged: a pointer
 * that is not RFC 6901 is refused rather than guessed at, a patch applies to a structured clone
 * so a rejected operation cannot half-mutate the state, and the first state event of a run is
 * preceded by a snapshot so a client that joined late has something to apply a delta to.
 *
 * WHY THE SNAPSHOT COMES FIRST. AG-UI lets a run send `STATE_DELTA` with no `STATE_SNAPSHOT`, and
 * the vendor's clients apply a delta to whatever they hold. A client holding nothing drops the
 * operations and the model's edits vanish silently — so the normalizer emits the state the run
 * started from, once, before the first delta.
 */

type OperationResult = { root: unknown; applied: boolean };

/** RFC 6901: `~` is only legal as `~0` or `~1`. */
function parseJsonPointer(pointer: string): string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return undefined;
  const segments = pointer.slice(1).split("/");
  if (segments.some((segment) => /~(?![01])/.test(segment))) return undefined;
  return segments.map((segment) =>
    segment.replace(/~1/g, "/").replace(/~0/g, "~"),
  );
}

function encodeJsonPointer(segments: readonly string[]): string {
  if (segments.length === 0) return "";
  return `/${segments
    .map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/")}`;
}

function getArrayIndex(segment: string, length: number): number | undefined {
  if (segment !== "0" && !/^[1-9]\d*$/.test(segment)) return undefined;
  const index = Number(segment);
  return Number.isSafeInteger(index) && index < length ? index : undefined;
}

function getJsonPointerValue(
  root: unknown,
  pointer: string,
): { exists: boolean; value?: unknown } {
  const segments = parseJsonPointer(pointer);
  if (segments === undefined) return { exists: false };
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object")
      return { exists: false };
    if (Array.isArray(current)) {
      const index = getArrayIndex(segment, current.length);
      if (index === undefined) return { exists: false };
      current = current[index];
    } else {
      const record = current as Record<string, unknown>;
      if (!Object.hasOwn(record, segment)) return { exists: false };
      current = record[segment];
    }
  }
  return { exists: true, value: current };
}

function getParent(
  root: unknown,
  segments: readonly string[],
): { exists: boolean; value?: unknown } {
  return getJsonPointerValue(root, encodeJsonPointer(segments.slice(0, -1)));
}

/** For state that `structuredClone` refuses: functions, class instances holding one, proxies. */
function cloneStateFallback(
  state: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (state === null || typeof state !== "object") return state;
  const existing = seen.get(state);
  if (existing !== undefined) return existing;
  let clone: Record<string, unknown> | unknown[];
  try {
    clone = Array.isArray(state)
      ? []
      : Object.create(Object.getPrototypeOf(state));
  } catch {
    clone = Array.isArray(state) ? [] : {};
  }
  seen.set(state, clone);
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(state);
  } catch {
    return clone;
  }
  for (const key of keys) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(state, key);
      if (!descriptor) continue;
      if ("value" in descriptor)
        descriptor.value = cloneStateFallback(descriptor.value, seen);
      Object.defineProperty(clone, key, descriptor);
    } catch {
      // A non-configurable key the clone cannot take: the original value stands.
    }
  }
  return clone;
}

export function cloneState<T>(state: T): T {
  try {
    return structuredClone(state);
  } catch {
    return cloneStateFallback(state) as T;
  }
}

function addValue(
  root: unknown,
  segments: readonly string[],
  value: unknown,
): OperationResult {
  if (segments.length === 0) return { root: cloneState(value), applied: true };
  const parent = getParent(root, segments);
  if (
    !parent.exists ||
    parent.value === null ||
    typeof parent.value !== "object"
  )
    return { root, applied: false };
  const segment = segments[segments.length - 1];
  if (Array.isArray(parent.value)) {
    if (segment === "-") {
      parent.value.push(cloneState(value));
      return { root, applied: true };
    }
    const index =
      segment === "0"
        ? 0
        : /^[1-9]\d*$/.test(segment)
          ? Number(segment)
          : undefined;
    if (
      index === undefined ||
      !Number.isSafeInteger(index) ||
      index > parent.value.length
    )
      return { root, applied: false };
    parent.value.splice(index, 0, cloneState(value));
    return { root, applied: true };
  }
  (parent.value as Record<string, unknown>)[segment] = cloneState(value);
  return { root, applied: true };
}

function removeValue(
  root: unknown,
  segments: readonly string[],
): OperationResult {
  if (segments.length === 0) return { root: undefined, applied: true };
  const parent = getParent(root, segments);
  if (
    !parent.exists ||
    parent.value === null ||
    typeof parent.value !== "object"
  )
    return { root, applied: false };
  const segment = segments[segments.length - 1];
  if (Array.isArray(parent.value)) {
    const index = getArrayIndex(segment, parent.value.length);
    if (index === undefined) return { root, applied: false };
    parent.value.splice(index, 1);
    return { root, applied: true };
  }
  const record = parent.value as Record<string, unknown>;
  if (!Object.hasOwn(record, segment)) return { root, applied: false };
  delete record[segment];
  return { root, applied: true };
}

function replaceValue(
  root: unknown,
  segments: readonly string[],
  value: unknown,
): OperationResult {
  if (segments.length === 0) return { root: cloneState(value), applied: true };
  const parent = getParent(root, segments);
  if (
    !parent.exists ||
    parent.value === null ||
    typeof parent.value !== "object"
  )
    return { root, applied: false };
  const segment = segments[segments.length - 1];
  if (Array.isArray(parent.value)) {
    const index = getArrayIndex(segment, parent.value.length);
    if (index === undefined) return { root, applied: false };
    parent.value[index] = cloneState(value);
    return { root, applied: true };
  }
  const record = parent.value as Record<string, unknown>;
  if (!Object.hasOwn(record, segment)) return { root, applied: false };
  record[segment] = cloneState(value);
  return { root, applied: true };
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      jsonValueEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}

type PatchOperation = {
  op?: unknown;
  path?: unknown;
  from?: unknown;
  value?: unknown;
};

function applyStateDeltaOperation(
  root: unknown,
  operation: PatchOperation,
): OperationResult {
  if (typeof operation.path !== "string") return { root, applied: false };
  const path = parseJsonPointer(operation.path);
  if (path === undefined) return { root, applied: false };
  switch (operation.op) {
    case "add":
      return addValue(root, path, operation.value);
    case "remove":
      return removeValue(root, path);
    case "replace":
      return replaceValue(root, path, operation.value);
    case "test": {
      const actual = getJsonPointerValue(root, operation.path);
      return {
        root,
        applied: actual.exists && jsonValueEqual(actual.value, operation.value),
      };
    }
    case "copy": {
      if (typeof operation.from !== "string") return { root, applied: false };
      const source = getJsonPointerValue(root, operation.from);
      if (!source.exists) return { root, applied: false };
      return addValue(root, path, source.value);
    }
    case "move": {
      if (typeof operation.from !== "string") return { root, applied: false };
      const from = parseJsonPointer(operation.from);
      if (from === undefined) return { root, applied: false };
      const source = getJsonPointerValue(root, operation.from);
      if (!source.exists) return { root, applied: false };
      if (operation.from === operation.path) return { root, applied: true };
      const removed = removeValue(cloneState(root), from);
      if (!removed.applied) return { root, applied: false };
      const added = addValue(removed.root, path, source.value);
      return added.applied ? added : { root, applied: false };
    }
    default:
      return { root, applied: false };
  }
}

/**
 * Prepends the array the model assumed exists.
 *
 * A model that writes `{op:"add",path:"/items/-"}` on a run whose state has no `items` array is
 * making the common JSON Patch mistake: `/-` appends, it does not create. Rather than dropping
 * every one of those edits, the normalizer inserts `[]` at the parent path first — but only when
 * the parent does exist, so a patch against state that is simply not there still fails.
 */
function normalizeStateDelta(
  delta: readonly unknown[],
  initialState: unknown,
): { delta: readonly unknown[]; state: unknown } {
  let state = cloneState(initialState);
  const normalized: unknown[] = [];
  for (const operation of delta) {
    const candidate =
      operation !== null && typeof operation === "object"
        ? (operation as PatchOperation)
        : undefined;
    if (
      candidate?.op === "add" &&
      typeof candidate.path === "string" &&
      candidate.path.endsWith("/-")
    ) {
      const arrayPath = candidate.path.slice(0, -2);
      if (!getJsonPointerValue(state, arrayPath).exists) {
        const lastSlash = arrayPath.lastIndexOf("/");
        const parentPath = lastSlash > 0 ? arrayPath.slice(0, lastSlash) : "";
        if (getJsonPointerValue(state, parentPath).exists) {
          const initializer: PatchOperation = {
            op: "add",
            path: arrayPath,
            value: [],
          };
          const applied = applyStateDeltaOperation(state, initializer);
          if (applied.applied) {
            normalized.push(initializer);
            state = applied.root;
          }
        }
      }
    }
    normalized.push(operation);
    if (candidate) {
      const applied = applyStateDeltaOperation(state, candidate);
      if (applied.applied) state = applied.root;
    }
  }
  return { delta: normalized, state };
}

/**
 * Turns a run's state events into the sequence a client can apply.
 *
 * The returned function is per run: it holds the state the run started from, and whether a
 * snapshot has gone out yet. Both are what decide whether the next delta needs one in front of
 * it.
 */
export function createStateEventNormalizer(
  initialState: unknown,
): (event: BaseEvent) => BaseEvent[] {
  let state = cloneState(initialState);
  let hasEmittedState = false;
  return (event) => {
    if (event.type === EventType.STATE_SNAPSHOT) {
      state = cloneState((event as { snapshot?: unknown }).snapshot);
      hasEmittedState = true;
      return [event];
    }
    if (event.type !== EventType.STATE_DELTA) return [event];
    const deltaEvent = event as { delta?: unknown };
    const initialSnapshot: BaseEvent[] =
      !hasEmittedState && initialState !== undefined
        ? [
            {
              type: EventType.STATE_SNAPSHOT,
              snapshot: cloneState(state),
            } as BaseEvent,
          ]
        : [];
    const normalized = Array.isArray(deltaEvent.delta)
      ? normalizeStateDelta(deltaEvent.delta, state)
      : { delta: deltaEvent.delta, state };
    state = normalized.state;
    hasEmittedState = true;
    return [
      ...initialSnapshot,
      { ...event, delta: normalized.delta } as BaseEvent,
    ];
  };
}
