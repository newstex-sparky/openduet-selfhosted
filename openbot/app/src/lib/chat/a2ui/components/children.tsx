import { Fragment, type ReactNode } from "react";
import type { BuildChild, ChildRef } from "../types";

/**
 * A structural child list arrives in one of two shapes: the static form A2UI payloads use is a bare
 * list of component ids, while a `List` template is expanded by the binder into `{ id, basePath }`
 * pairs — one per item, each with its own slice of the data model. Both are drawn the same way.
 */
function toChildRef(entry: unknown): ChildRef | undefined {
  if (typeof entry === "string") return { id: entry };
  if (typeof entry === "object" && entry !== null && "id" in entry) {
    const { id, basePath } = entry as ChildRef;
    return typeof id === "string" ? { id, basePath } : undefined;
  }
  return undefined;
}

export function buildChildren(
  children: unknown,
  buildChild: BuildChild,
): ReactNode {
  if (!Array.isArray(children)) return null;
  return children
    .map(toChildRef)
    .filter((child): child is ChildRef => child !== undefined)
    .map((child) => (
      <Fragment key={`${child.id}-${child.basePath ?? ""}`}>
        {buildChild(child.id, child.basePath)}
      </Fragment>
    ));
}
