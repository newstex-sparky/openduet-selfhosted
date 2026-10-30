/**
 * Drawing an interface the Bot wrote in the browser.
 *
 * The content arrives in pieces while the Bot writes it — CSS, then the markup, then the functions
 * those call — so it is drawn from whatever has arrived, inside a frame that cannot reach this page.
 * Nothing here decides what is allowed: that is the component grants, and the server's own decision
 * about the tool call. This only draws what it was handed.
 */
import type { AbstractAgent } from "@ag-ui/client";
import type { ActivityMessage } from "@ag-ui/core";

export type OpenGenerativeUIActivityType = "open-generative-ui";

/** What a generative-UI activity carries, complete or still arriving. */
export interface OpenGenerativeUIContent {
  css?: string;
  cssComplete?: boolean;
  /** The markup, in the order it was written. */
  html?: string[];
  htmlComplete?: boolean;
  /** Functions the markup may call. */
  jsFunctions?: string;
  jsFunctionsComplete?: boolean;
  /** Still being written: the frame is redrawn as more arrives. */
  generating?: boolean;
}

export interface OpenGenerativeUIActivityRendererProps {
  activityType: string;
  content: OpenGenerativeUIContent;
  agent?: AbstractAgent | null;
  message?: ActivityMessage | null;
}

/** The base a generated interface inherits, so it is legible before its own CSS arrives. */
const BASE_STYLE = `
:root { color-scheme: light dark; }
html, body { margin: 0; }
body { font: 14px/1.5 system-ui, sans-serif; padding: 12px; }
`;

/**
 * The document that goes inside the frame.
 *
 * The script is included only once its whole body has arrived: a half-written function is a
 * syntax error, and a frame that throws on load shows nothing at all. The markup is included as it
 * comes, because half a page still reads as the beginning of one.
 */
export function generatedDocument(content: OpenGenerativeUIContent): string {
  const html = (content.html ?? []).join("");
  const css = content.css ?? "";
  const script =
    content.jsFunctionsComplete && content.jsFunctions
      ? `<script>${content.jsFunctions}</script>`
      : "";
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<style>${BASE_STYLE}${css}</style>`,
    "</head><body>",
    html,
    script,
    "</body></html>",
  ].join("");
}

/**
 * One generated interface.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` is the load-bearing part: the frame gets a
 * unique origin, so nothing it runs can read this app's cookies, storage or DOM. A frame that could
 * do either would be a place for a Bot's output to act as the person.
 */
export function OpenGenerativeUIActivityRenderer({
  activityType,
  content,
}: OpenGenerativeUIActivityRendererProps) {
  return (
    <div
      className="my-2 overflow-hidden rounded-lg border"
      data-openbot-generative-ui={activityType}
    >
      {content.generating ? (
        <div
          className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
          role="status"
        >
          Writing this interface…
        </div>
      ) : null}
      <iframe
        className="h-96 w-full border-0 bg-background"
        // Named for a screen reader, since the frame's own title is the Bot's to write.
        title={`Interface from ${activityType}`}
        sandbox="allow-scripts"
        srcDoc={generatedDocument(content)}
      />
    </div>
  );
}
