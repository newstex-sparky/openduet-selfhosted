import { ModalApi, TabsApi } from "@a2ui/web_core/v0_9/basic_catalog";
import { useState } from "react";
import { createReactComponent } from "../adapter";
import type { ComponentViewProps } from "../types";

/**
 * Tabs switch which child is drawn. The open tab is renderer state, not data-model state: it is a
 * view choice, so it must not turn into a `setState` action the agent has to reason about.
 */
function TabsView({ props, buildChild }: ComponentViewProps<typeof TabsApi>) {
  const [active, setActive] = useState(0);
  const tabs = Array.isArray(props.tabs) ? props.tabs : [];
  if (tabs.length === 0) return null;
  const current = tabs[Math.min(active, tabs.length - 1)];
  return (
    <div>
      <div
        role="tablist"
        style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}
      >
        {tabs.map((tab, index) => (
          <button
            key={`${tab.title}-${tab.child}`}
            type="button"
            role="tab"
            aria-selected={index === active}
            onClick={() => setActive(index)}
            style={{
              padding: "0.3rem 0.7rem",
              borderBottom:
                index === active ? "2px solid currentColor" : "none",
            }}
          >
            {String(tab.title ?? "")}
          </button>
        ))}
      </div>
      <div role="tabpanel">{buildChild(current.child)}</div>
    </div>
  );
}

/**
 * A Modal is a disclosure here: the trigger is always drawn and the content appears under it when
 * opened. A real overlay would need a portal and focus trapping to be usable, and getting those
 * half-right is worse than an inline panel that never traps anyone.
 */
function ModalView({ props, buildChild }: ComponentViewProps<typeof ModalApi>) {
  return (
    <details>
      <summary>{buildChild(props.trigger)}</summary>
      <div>{buildChild(props.content)}</div>
    </details>
  );
}

export const Tabs = createReactComponent(TabsApi, TabsView);
export const Modal = createReactComponent(ModalApi, ModalView);
