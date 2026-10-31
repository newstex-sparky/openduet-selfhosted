import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import type { ActivityMessage } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import {
  activityProgress,
  CopilotKit,
  generatedDocument,
  generativeUIActivityRenderers,
  OpenGenerativeUIActivityRenderer,
  type OpenGenerativeUIContent,
} from "@/lib/agui";
import { activityRenderers } from "@/lib/copilot/activity-renderers";
import { settleReactWork } from "./settle-react-work";

/**
 * The interface a Bot writes, drawn from the pieces the runtime streams.
 *
 * What is checked here is the part this app owns: how chunks become one document, when a part is
 * allowed to count as finished, and that the document only ever runs inside the frame. The
 * `open-generative-ui` content shape is the runtime middleware's, so the fixtures are what that
 * middleware actually emits — a single `css` value, a growing `html` array, a single `jsFunctions`
 * value, and `generating` cleared when the tool call ends.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const MESSAGE = {
  id: "activity-1",
  role: "activity",
  activityType: "open-generative-ui",
  content: {},
} as ActivityMessage;

/** A finished interface: every part arrived and the call ended. */
const FINISHED: OpenGenerativeUIContent = {
  css: ".card { color: #0a0a0a }",
  cssComplete: true,
  html: ['<div class="card">', "<p>Grouped</p>", "</div>"],
  htmlComplete: true,
  jsFunctions: 'document.querySelector(".card").dataset.ready = "1";',
  jsFunctionsComplete: true,
  generating: false,
};

/** Mid-stream: the markup is still growing and the call has not ended. */
const STREAMING: OpenGenerativeUIContent = {
  css: ".card { color: #0a0a0a }",
  cssComplete: true,
  html: ['<div class="card">'],
  htmlComplete: false,
  generating: true,
};

function frameFrom(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector("iframe");
  expect(frame).not.toBeNull();
  return frame as HTMLIFrameElement;
}

/** React writes `srcDoc` as the `srcdoc` attribute; read whichever the DOM kept. */
function sourceOf(frame: HTMLIFrameElement): string {
  return frame.getAttribute("srcdoc") ?? frame.srcdoc;
}

describe("what a generated interface is built from", () => {
  test("joins the markup chunks in the order the Bot wrote them", () => {
    const document = generatedDocument(FINISHED);
    expect(document).toContain(
      '<div class="card"><p>Grouped</p></div>' as string,
    );
  });

  test("lays the activity's own CSS over the base that makes it legible first", () => {
    const document = generatedDocument(FINISHED);
    const base = document.indexOf("html, body { margin: 0; }");
    const css = document.indexOf(".card { color: #0a0a0a }");
    expect(base).toBeGreaterThan(-1);
    expect(css).toBeGreaterThan(base);
  });

  test("leaves the functions out while they are still arriving", () => {
    const partial: OpenGenerativeUIContent = {
      ...STREAMING,
      jsFunctions: "function draw() {",
      jsFunctionsComplete: false,
    };
    const document = generatedDocument(partial);
    expect(document).not.toContain("<script");
    expect(document).not.toContain("function draw() {");
  });

  test("runs the functions once their whole body has arrived", () => {
    const document = generatedDocument(FINISHED);
    expect(document).toContain("<script>");
    expect(document).toContain('dataset.ready = "1";');
  });

  test("a literal closing script tag in the functions cannot end the element early", () => {
    const document = generatedDocument({
      ...FINISHED,
      jsFunctions: 'const end = "</script><p>escaped</p>";',
    });
    expect(document).toContain('const end = "<\\/script><p>escaped</p>";');
    // The one and only real end tag is the one this module wrote.
    expect(document.match(/<\/script>/g)).toHaveLength(1);
  });

  test("writes each part's completion onto the document root", () => {
    const streaming = generatedDocument(STREAMING);
    expect(streaming).toContain('data-css-complete="true"');
    expect(streaming).toContain('data-html-complete="false"');
    expect(streaming).toContain('data-js-complete="false"');
    expect(streaming).toContain('data-generating="true"');

    const finished = generatedDocument(FINISHED);
    expect(finished).toContain('data-html-complete="true"');
    expect(finished).toContain('data-js-complete="true"');
    expect(finished).toContain('data-generating="false"');
  });
});

describe("completion and generating states", () => {
  test("is complete only when every part arrived and the call ended", () => {
    expect(activityProgress(FINISHED).complete).toBe(true);
  });

  test("a call that is still generating is never complete, whatever arrived", () => {
    const progress = activityProgress({ ...FINISHED, generating: true });
    expect(progress.complete).toBe(false);
    expect(progress.generating).toBe(true);
  });

  test("a run that ended with a part missing is incomplete, not finished", () => {
    const cut: OpenGenerativeUIContent = {
      css: ".card {}",
      cssComplete: true,
      html: ['<div class="card">'],
      htmlComplete: false,
      generating: false,
    };
    expect(activityProgress(cut).complete).toBe(false);
    expect(generatedDocument(cut)).not.toContain("<script");
  });

  test("draws a status while the interface is being written", () => {
    const view = render(
      <OpenGenerativeUIActivityRenderer
        activityType="open-generative-ui"
        content={STREAMING}
      />,
    );
    const wrapper = view.container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute("data-openbot-generative-ui-state")).toBe(
      "generating",
    );
    expect(view.getByRole("status").textContent).toBe(
      "Writing this interface…",
    );
  });

  test("says so when the output stopped before it was finished", () => {
    const view = render(
      <OpenGenerativeUIActivityRenderer
        activityType="open-generative-ui"
        content={{ ...FINISHED, generating: false, htmlComplete: false }}
      />,
    );
    const wrapper = view.container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute("data-openbot-generative-ui-state")).toBe(
      "incomplete",
    );
    expect(view.getByRole("status").textContent).toBe(
      "This interface did not finish arriving.",
    );
  });

  test("draws a finished interface without a status line", () => {
    const view = render(
      <OpenGenerativeUIActivityRenderer
        activityType="open-generative-ui"
        content={FINISHED}
      />,
    );
    const wrapper = view.container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute("data-openbot-generative-ui-state")).toBe(
      "complete",
    );
    expect(view.queryByRole("status")).toBeNull();
  });
});

describe("the frame", () => {
  test("grants scripts and nothing else: no same-origin, no navigation, no forms", () => {
    const view = render(
      <OpenGenerativeUIActivityRenderer
        activityType="open-generative-ui"
        content={FINISHED}
      />,
    );
    const frame = frameFrom(view.container);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups");
  });

  test("carries the assembled document as its source", () => {
    const view = render(
      <OpenGenerativeUIActivityRenderer
        activityType="open-generative-ui"
        content={FINISHED}
      />,
    );
    expect(sourceOf(frameFrom(view.container))).toBe(
      generatedDocument(FINISHED),
    );
  });

  test("names the activity type for a reader who cannot see the frame", () => {
    const view = render(
      <OpenGenerativeUIActivityRenderer
        activityType="open-generative-ui"
        content={FINISHED}
      />,
    );
    expect(frameFrom(view.container).getAttribute("title")).toBe(
      "Interface from open-generative-ui",
    );
  });
});

describe("malformed or partial content", () => {
  test("draws an empty document rather than throwing when nothing usable arrived", () => {
    const view = render(
      <OpenGenerativeUIActivityRenderer
        activityType="open-generative-ui"
        content={{}}
      />,
    );
    expect(sourceOf(frameFrom(view.container))).toContain("<body></body>");
  });

  test("keeps the markup parts that are strings and drops the ones that are not", () => {
    const malformed = {
      css: 42,
      html: ["<p>first</p>", null, 7, { tag: "p" }, "<p>last</p>"],
      jsFunctions: { source: "draw()" },
      jsFunctionsComplete: true,
    } as unknown as OpenGenerativeUIContent;
    const document = generatedDocument(malformed);
    expect(document).toContain("<p>first</p><p>last</p>");
    expect(document).not.toContain("42");
    expect(document).not.toContain("[object Object]");
    // A functions value of the wrong type is not a script body.
    expect(document).not.toContain("<script");
  });

  test("reads a single markup string as the whole page", () => {
    const document = generatedDocument({
      html: "<p>one piece</p>",
    } as unknown as OpenGenerativeUIContent);
    expect(document).toContain("<p>one piece</p>");
  });

  test("does not throw on content that is missing entirely", () => {
    expect(() =>
      generatedDocument(undefined as unknown as OpenGenerativeUIContent),
    ).not.toThrow();
  });
});

describe("wiring into the activity path", () => {
  test("registers nothing when the deployment cannot generate interfaces", () => {
    expect(generativeUIActivityRenderers(false)).toEqual([]);
    expect(generativeUIActivityRenderers(undefined)).toEqual([]);
    expect(activityRenderers(false)).toEqual([]);
    expect(activityRenderers(undefined)).toEqual([]);
  });

  test("registers an A2UI surface renderer and the Bot's own interface together", () => {
    expect(activityRenderers(true).map((entry) => entry.activityType)).toEqual([
      "a2ui-surface",
      "open-generative-ui",
    ]);
  });

  test("the registry the provider builds finds the renderer for the activity type", () => {
    const copilotkit = new CopilotKit({
      runtimeUrl: "/api/copilotkit",
      renderActivityMessages: activityRenderers(true),
    });
    expect(
      copilotkit.activityRendererFor("open-generative-ui", undefined)
        ?.activityType,
    ).toBe("open-generative-ui");
  });

  test("the renderer the registry hands a message draws the sandboxed frame", () => {
    const entry = generativeUIActivityRenderers(true)[0];
    expect(entry).toBeDefined();
    const drawn = entry?.render({
      activityType: "open-generative-ui",
      content: STREAMING,
      message: MESSAGE,
      agent: undefined,
    });
    const view = render(drawn as ReactElement);
    const frame = frameFrom(view.container);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(sourceOf(frame)).toBe(generatedDocument(STREAMING));
  });
});

describe("first-party only", () => {
  const source = readFileSync(
    new URL("../src/lib/agui/generative-ui.tsx", import.meta.url),
    "utf8",
  );
  const wiring = readFileSync(
    new URL("../src/lib/copilot/activity-renderers.ts", import.meta.url),
    "utf8",
  );

  test("the renderer imports no CopilotKit module", () => {
    expect(source).not.toContain("@copilotkit");
    expect(wiring).not.toContain("@copilotkit");
  });

  test("the parent page never executes the activity's own source", () => {
    for (const forbidden of [
      "eval(",
      "new Function",
      "dangerouslySetInnerHTML",
      "innerHTML",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
