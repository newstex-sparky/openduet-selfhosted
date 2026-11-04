import { TextApi } from "@a2ui/web_core/v0_9/basic_catalog";
import { createReactComponent } from "../adapter";
import type { ComponentViewProps } from "../types";

/**
 * `Text` is the catalog's only prose component, and its `variant` is the heading level: an `h3`
 * reads as a section title inside a Card, `caption` as small print under it. Anything else is body
 * copy, which is what a generated form mostly is.
 */
function TextView({ props }: ComponentViewProps<typeof TextApi>) {
  const text = String(props.text ?? "");
  switch (props.variant) {
    case "h1":
      return <h1>{text}</h1>;
    case "h2":
      return <h2>{text}</h2>;
    case "h3":
      return <h3>{text}</h3>;
    case "h4":
      return <h4>{text}</h4>;
    case "h5":
      return <h5>{text}</h5>;
    case "caption":
      return <small>{text}</small>;
    default:
      return <p>{text}</p>;
  }
}

export const Text = createReactComponent(TextApi, TextView);
