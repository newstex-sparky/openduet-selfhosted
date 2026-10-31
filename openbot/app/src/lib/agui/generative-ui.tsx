/**
 * Drawing an interface the Bot wrote in the browser.
 *
 * The content arrives in pieces while the Bot writes it — CSS, then the markup, then the functions
 * those call — so it is drawn from whatever has arrived, inside a frame that cannot reach this page.
 * Nothing here decides what is allowed: that is the component grants, and the server's own decision
 * about the tool call. This only draws what it was handed.
 *
 * THE PIECES ARE WHAT THE RUNTIME'S `open-generative-ui` MIDDLEWARE EMITS. It writes the CSS and the
 * functions as single values and flags them complete as they land, but it writes the markup as an
 * array of chunks that grows while the tool call is still streaming, and it clears `generating` when
 * the call ends. So "finished" is three flags and the generating bit, never the arrival of a chunk:
 * a half-written function is a syntax error and a frame that throws on load shows nothing at all.
 */
import type { AbstractAgent } from "@ag-ui/client";
import type { ActivityMessage } from "@ag-ui/core";
import type { ReactActivityMessageRenderer } from "./types";

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

/** How much of an activity has arrived, as the flags on its content say. */
export interface OpenGenerativeUIProgress {
  /** The tool call is still streaming. */
  generating: boolean;
  cssComplete: boolean;
  htmlComplete: boolean;
  jsFunctionsComplete: boolean;
  /** Every part arrived and the call ended: the only state that may be drawn as final. */
  complete: boolean;
}

/** The base a generated interface inherits, so it is legible before its own CSS arrives. */
const BASE_STYLE = `
:root { color-scheme: light dark; }
html, body { margin: 0; }
body { font: 14px/1.5 system-ui, sans-serif; padding: 12px; }
`;

/**
 * A string, or the empty string.
 *
 * `content` crosses the wire, so its fields are only as trustworthy as the stream that carried them:
 * a field can be missing, null, or the wrong type on a truncated run. Coercing here keeps a malformed
 * activity from throwing inside the renderer, where the boundary would draw its failure sentence
 * over a frame that had almost all of its content.
 */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The markup parts in the order they arrived; anything that is not a string is dropped. */
function htmlParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((part): part is string => typeof part === "string");
}

/**
 * A script body that cannot close the element it sits in early.
 *
 * The functions are the Bot's own source, so a literal `</script>` in a string it writes would end
 * the element at that byte and turn the rest of the function into markup. `<\/script` is the same
 * character sequence to the JavaScript parser — inside a string, a regex or a comment alike — and is
 * not an end tag to the HTML parser.
 */
function scriptSafe(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

/**
 * How complete an activity is.
 *
 * `generating` alone is not enough: a run that fails mid-stream can leave the call ended with the
 * markup unfinished, and a caller that drew that as final would present half a page as the page.
 */
export function activityProgress(
  content: OpenGenerativeUIContent,
): OpenGenerativeUIProgress {
  const generating = content?.generating === true;
  const cssComplete = content?.cssComplete === true;
  const htmlComplete = content?.htmlComplete === true;
  const jsFunctionsComplete = content?.jsFunctionsComplete === true;
  return {
    generating,
    cssComplete,
    htmlComplete,
    jsFunctionsComplete,
    complete: !generating && cssComplete && htmlComplete && jsFunctionsComplete,
  };
}

/** What state the drawn interface is in, for the frame's wrapper and for a reader. */
function drawnState(progress: OpenGenerativeUIProgress): string {
  if (progress.complete) return "complete";
  return progress.generating ? "generating" : "incomplete";
}

/**
 * The document that goes inside the frame.
 *
 * The script is included only once its whole body has arrived: a half-written function is a syntax
 * error, and a frame that throws on load shows nothing at all. The markup is included as it comes,
 * because half a page still reads as the beginning of one, and the root element carries each part's
 * completion so that anything reading the document can tell a partial page from a finished one.
 */
export function generatedDocument(content: OpenGenerativeUIContent): string {
  const progress = activityProgress(content);
  const css = asText(content?.css);
  const html = htmlParts(content?.html).join("");
  const script = progress.jsFunctionsComplete
    ? scriptSafe(asText(content?.jsFunctions))
    : "";
  return [
    "<!doctype html><html",
    ` data-css-complete="${progress.cssComplete}"`,
    ` data-html-complete="${progress.htmlComplete}"`,
    ` data-js-complete="${progress.jsFunctionsComplete}"`,
    ` data-generating="${progress.generating}">`,
    '<head><meta charset="utf-8">',
    `<style>${BASE_STYLE}${css}</style>`,
    "</head><body>",
    html,
    script ? `<script>${script}</script>` : "",
    "</body></html>",
  ].join("");
}

/**
 * One generated interface.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` is the load-bearing part: the frame gets a
 * unique origin, so nothing it runs can read this app's cookies, storage or DOM. A frame that could
 * do either would be a place for a Bot's output to act as the person. The scripts run inside that
 * origin and nowhere else — this module never evaluates the activity's source in the parent page.
 */
export function OpenGenerativeUIActivityRenderer({
  activityType,
  content,
}: OpenGenerativeUIActivityRendererProps) {
  const progress = activityProgress(content);
  return (
    <div
      className="my-2 overflow-hidden rounded-lg border"
      data-openbot-generative-ui={activityType}
      data-openbot-generative-ui-state={drawnState(progress)}
    >
      {progress.complete ? null : (
        <div
          className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
          role="status"
        >
          {progress.generating
            ? "Writing this interface…"
            : "This interface did not finish arriving."}
        </div>
      )}
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

/**
 * The activity renderer, for a provider that can draw one.
 *
 * A deployment with the server half off and the browser half on would have Bots writing interfaces
 * nothing draws, so this is registered on the same `generativeUi` capability that turns the
 * middleware on; see `DeploymentCapabilities.generativeUi` and `activityRenderers`.
 *
 * `content` is typed `unknown` on the way in because an activity is wire data: the cast below states
 * the contract this renderer reads, and `generatedDocument` is what makes a message that does not
 * honour it safe rather than fatal.
 */
export function generativeUIActivityRenderers(
  enabled: boolean | undefined,
): ReactActivityMessageRenderer<unknown>[] {
  if (!enabled) return [];
  return [
    {
      activityType: "open-generative-ui",
      render: ({ activityType, content, agent, message }) => (
        <OpenGenerativeUIActivityRenderer
          activityType={activityType}
          agent={agent}
          content={(content ?? {}) as OpenGenerativeUIContent}
          message={message}
        />
      ),
    },
  ];
}
