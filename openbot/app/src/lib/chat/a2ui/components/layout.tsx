import {
  CardApi,
  ColumnApi,
  DividerApi,
  ListApi,
  RowApi,
} from "@a2ui/web_core/v0_9/basic_catalog";
import type { CSSProperties } from "react";
import { createReactComponent } from "../adapter";
import type { ComponentViewProps } from "../types";
import { buildChildren } from "./children";

const JUSTIFY: Record<string, CSSProperties["justifyContent"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  spaceBetween: "space-between",
  spaceAround: "space-around",
  spaceEvenly: "space-evenly",
  stretch: "stretch",
};

const ALIGN: Record<string, CSSProperties["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
};

/**
 * A Card is one surface's frame: a single `child`, a background, a border. The background and
 * padding live in `a2ui.css` (`[data-openbot-a2ui="Card"] > div`) so they follow the app's tokens
 * rather than a second copy of them here.
 */
function CardView({ props, buildChild }: ComponentViewProps<typeof CardApi>) {
  return <div>{buildChild(props.child)}</div>;
}

function ColumnView({
  props,
  buildChild,
}: ComponentViewProps<typeof ColumnApi>) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        justifyContent: JUSTIFY[props.justify ?? "start"],
        alignItems: ALIGN[props.align ?? "start"],
      }}
    >
      {buildChildren(props.children, buildChild)}
    </div>
  );
}

function RowView({ props, buildChild }: ComponentViewProps<typeof RowApi>) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        flexWrap: "wrap",
        gap: "0.75rem",
        justifyContent: JUSTIFY[props.justify ?? "start"],
        alignItems: ALIGN[props.align ?? "center"],
      }}
    >
      {buildChildren(props.children, buildChild)}
    </div>
  );
}

/**
 * A List is a set of sibling rows, not a virtualised list: the binder has already expanded the
 * template against the data model, so each item is an ordinary component with its own base path.
 */
function ListView({ props, buildChild }: ComponentViewProps<typeof ListApi>) {
  const horizontal = props.direction === "horizontal";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        gap: "0.5rem",
        alignItems: ALIGN[props.align ?? "stretch"],
      }}
    >
      {buildChildren(props.children, buildChild)}
    </div>
  );
}

function DividerView({ props }: ComponentViewProps<typeof DividerApi>) {
  if (props.axis === "vertical") {
    return (
      <hr
        style={{
          width: 0,
          height: "1em",
          borderLeft: "1px solid currentColor",
          borderRight: "none",
          margin: 0,
        }}
      />
    );
  }
  return (
    <hr
      style={{
        width: "100%",
        borderTop: "1px solid currentColor",
        borderBottom: "none",
      }}
    />
  );
}

export const Card = createReactComponent(CardApi, CardView);
export const Column = createReactComponent(ColumnApi, ColumnView);
export const Row = createReactComponent(RowApi, RowView);
export const List = createReactComponent(ListApi, ListView);
export const Divider = createReactComponent(DividerApi, DividerView);
