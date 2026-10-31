import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
} from "@testing-library/react";
import {
  type Attachment,
  type AttachmentsConfig,
  type AttachmentUploadError,
  type UseAttachmentsReturn,
  useAttachments,
} from "@/lib/agui";
import { settleReactWork } from "./settle-react-work";

/**
 * THE HOOK THE COMPOSER BINDS, EXERCISED AS THE COMPOSER BINDS IT.
 *
 * What is pinned here is the contract rather than a screen: exactly seven names come back, a
 * disabled hook takes no files and is no drop target, an enabled one turns a `File` into an
 * attachment carrying the reference the message will send, a refusal is spoken through
 * `onUploadFailed` and leaves no chip, and removal takes one id and no more. Those are the
 * behaviours `composer.tsx` hangs its screening, its cap and its queue branch off, so a change that
 * quietly reshaped any of them would show up here before it showed up as a lost file on screen.
 *
 * THE TYPE BLOCK IS PART OF THE TEST, NOT A FORMALITY. The hook answers to the shapes recorded on
 * the Phase 5 card: `Attachment` with exactly `id`, `type`, `source`, `filename`, `size`, `status`,
 * `metadata`, and `AttachmentsConfig` with exactly `enabled`, `accept`, `maxSize`, `onUpload`,
 * `onUploadFailed` — the last of which receives `{ file, message }`. `Equal` fails to compile if a
 * field is added, removed or renamed, so an incompatible model cannot be introduced by accident.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, and `settleReactWork()` before the document goes away — see
 * `composer-attachment-lifecycle.test.tsx` for why bun's single-process walk makes that mandatory.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** Type-level equality: a `false` here is a compile error, not a failing expectation. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** The seven names, in the order the card records them. */
const CONTRACT = [
  "attachments",
  "enabled",
  "fileInputRef",
  "processFiles",
  "handleDragOver",
  "handleDragLeave",
  "removeAttachment",
] as const;

/** Whatever the last render of the probe returned, so a test can call into the hook. */
let hook: UseAttachmentsReturn;

/** Files the probe's button hands to `processFiles` on the next press. */
let toProcess: File[] = [];

/**
 * The hook, rendered the way a composer renders it: unconditionally, with a config that may be
 * absent, and with the file input wired to the ref it returns.
 */
function Probe({ config }: { config?: AttachmentsConfig }) {
  hook = useAttachments({ config });
  return (
    <div>
      <input data-testid="file-input" ref={hook.fileInputRef} type="file" />
      <span data-testid="enabled">{String(hook.enabled)}</span>
      <span data-testid="strip">
        {hook.attachments
          .map((attachment) => `${attachment.filename}:${attachment.status}`)
          .join(",")}
      </span>
      <button
        onClick={() => {
          void hook.processFiles(toProcess);
        }}
        type="button"
      >
        process
      </button>
    </div>
  );
}

/** The same hook, with the drag pair wired to a real element the way `composer.tsx` wires them. */
function DragProbe({ config }: { config?: AttachmentsConfig }) {
  hook = useAttachments({ config });
  return (
    <>
      {/** biome-ignore lint/a11y/noStaticElementInteractions: a stand-in drop zone, not a control. */}
      <div
        data-testid="zone"
        onDragLeave={hook.handleDragLeave}
        onDragOver={hook.handleDragOver}
      >
        <span data-testid="child">child</span>
      </div>
    </>
  );
}

function image(name = "shot.png"): File {
  return new File(["bytes"], name, { type: "image/png" });
}

function notes(): File {
  return new File(["hello"], "notes.txt", { type: "text/plain" });
}

/** Press the probe's button, which hands its files to `processFiles`. */
async function process(files: File[]): Promise<void> {
  toProcess = files;
  await act(async () => {
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
  });
}

function strip(element: HTMLElement): string {
  return element.querySelector('[data-testid="strip"]')?.textContent ?? "";
}

test("returns exactly the seven names the contract names", () => {
  const view = render(<Probe config={{ enabled: true }} />);
  expect(Object.keys(hook).sort()).toEqual([...CONTRACT].sort());
  // Seven and no eighth: a `dragOver` flag, a drop handler or a sweep would each be a name the
  // composer does not bind and the contract does not carry.
  expect(Object.keys(hook)).toHaveLength(CONTRACT.length);
  expect(typeof hook.processFiles).toBe("function");
  expect(typeof hook.handleDragOver).toBe("function");
  expect(typeof hook.handleDragLeave).toBe("function");
  expect(typeof hook.removeAttachment).toBe("function");
  expect(hook.attachments).toEqual([]);
  expect(hook.enabled).toBe(true);
  expect(hook.fileInputRef.current).toBe(
    view.getByTestId("file-input") as HTMLInputElement,
  );
});

test("with no config at all the hook is disabled and takes no files", async () => {
  const view = render(<Probe />);
  expect(hook.enabled).toBe(false);
  expect(view.getByTestId("enabled").textContent).toBe("false");
  await process([image()]);
  expect(strip(view.container)).toBe("");
  expect(hook.attachments).toEqual([]);
});

test("a config that says enabled: false uploads nothing, however many files it is handed", async () => {
  let calls = 0;
  const view = render(
    <Probe
      config={{
        enabled: false,
        onUpload: async () => {
          calls += 1;
          return { type: "data", value: "data:x", mimeType: "text/plain" };
        },
        onUploadFailed: () => {
          calls += 1;
        },
      }}
    />,
  );
  expect(hook.enabled).toBe(false);
  await process([image(), notes()]);
  expect(calls).toBe(0);
  expect(strip(view.container)).toBe("");
});

test("an enabled hook uploads a file and the strip carries the reference the message will send", async () => {
  const view = render(
    <Probe
      config={{
        enabled: true,
        onUpload: async (file) => ({
          type: "url",
          value: `/api/attachments/${file.name}`,
          mimeType: file.type,
          metadata: { attachmentId: file.name },
        }),
      }}
    />,
  );
  await process([image()]);
  expect(strip(view.container)).toBe("shot.png:ready");
  const [attachment] = hook.attachments;
  expect(attachment.type).toBe("image");
  expect(attachment.status).toBe("ready");
  expect(attachment.filename).toBe("shot.png");
  expect(attachment.size).toBe(5);
  expect(attachment.source).toEqual({
    type: "url",
    value: "/api/attachments/shot.png",
    mimeType: "image/png",
  });
  expect(attachment.metadata).toEqual({ attachmentId: "shot.png" });
  // The exact field set, so a model nobody agreed to cannot grow here.
  expect(Object.keys(attachment).sort()).toEqual([
    "filename",
    "id",
    "metadata",
    "size",
    "source",
    "status",
    "type",
  ]);
});

test("a file whose type names no format is a document, not an image", async () => {
  render(
    <Probe
      config={{
        enabled: true,
        onUpload: async () => ({
          type: "data",
          value: "data:x",
          mimeType: "text/plain",
        }),
      }}
    />,
  );
  await process([new File(["bytes"], "export", { type: "" })]);
  const [attachment] = hook.attachments;
  expect(attachment.type).toBe("document");
  expect(attachment.source).toEqual({
    type: "data",
    value: "data:x",
    mimeType: "text/plain",
  });
});

test("a file outside the config's accept is refused, spoken, and never uploaded", async () => {
  const refusals: { file: File; message: string }[] = [];
  let uploads = 0;
  const view = render(
    <Probe
      config={{
        enabled: true,
        accept: "image/*",
        onUpload: async () => {
          uploads += 1;
          return { type: "data", value: "data:x", mimeType: "text/plain" };
        },
        onUploadFailed: ({ file, message }) => {
          refusals.push({ file, message });
        },
      }}
    />,
  );
  await process([notes()]);
  expect(uploads).toBe(0);
  expect(strip(view.container)).toBe("");
  expect(refusals).toHaveLength(1);
  expect(refusals[0].file.name).toBe("notes.txt");
  expect(refusals[0].message).toContain("notes.txt");
});

test("a file over the config's maxSize is refused in the same words as any other refusal", async () => {
  const refusals: { file: File; message: string }[] = [];
  const view = render(
    <Probe
      config={{
        enabled: true,
        maxSize: 4,
        onUpload: async () => ({
          type: "data",
          value: "data:x",
          mimeType: "text/plain",
        }),
        onUploadFailed: ({ file, message }) => {
          refusals.push({ file, message });
        },
      }}
    />,
  );
  await process([notes()]);
  expect(strip(view.container)).toBe("");
  expect(refusals).toHaveLength(1);
  expect(refusals[0].message).toContain("too large");
});

test("a failed upload leaves no chip behind and reports the uploader's own sentence", async () => {
  const refusals: { file: File; message: string }[] = [];
  const view = render(
    <Probe
      config={{
        enabled: true,
        onUpload: async () => {
          throw new Error("the channel refused this file");
        },
        onUploadFailed: ({ file, message }) => {
          refusals.push({ file, message });
        },
      }}
    />,
  );
  await process([notes()]);
  expect(strip(view.container)).toBe("");
  expect(hook.attachments).toEqual([]);
  expect(refusals).toHaveLength(1);
  expect(refusals[0].message).toBe("the channel refused this file");
});

test("drag-over is a drop target while enabled, and not one while disabled", () => {
  const view = render(<DragProbe config={{ enabled: true }} />);
  const zone = view.getByTestId("zone");
  const over = createEvent.dragOver(zone);
  fireEvent(zone, over);
  expect(over.defaultPrevented).toBe(true);

  view.rerender(<DragProbe config={{ enabled: false }} />);
  const refused = createEvent.dragOver(view.getByTestId("zone"));
  fireEvent(view.getByTestId("zone"), refused);
  expect(refused.defaultPrevented).toBe(false);
});

test("drag-leave stops at the composer, cancels nothing, and never reaches a container above it", () => {
  // A container above the composer, listening natively — the shape a page-level drop overlay has.
  let leaves = 0;
  const above = (): void => {
    leaves += 1;
  };
  document.addEventListener("dragleave", above);

  const view = render(<DragProbe config={{ enabled: true }} />);
  const leave = createEvent.dragLeave(view.getByTestId("child"));
  fireEvent(view.getByTestId("child"), leave);
  expect(leave.defaultPrevented).toBe(false);
  expect(leaves).toBe(0);

  // The control: the same event over an element with no handler of its own does reach the
  // container, so the zero above is the hook stopping it rather than the harness losing it.
  const plain = render(<div data-testid="plain">plain</div>);
  fireEvent.dragLeave(plain.getByTestId("plain"));
  expect(leaves).toBe(1);

  document.removeEventListener("dragleave", above);
});

test("removeAttachment takes the id it is given and leaves every other chip alone", async () => {
  const view = render(
    <Probe
      config={{
        enabled: true,
        onUpload: async (file) => ({
          type: "url",
          value: `/api/attachments/${file.name}`,
        }),
      }}
    />,
  );
  await process([image("one.png"), image("two.png")]);
  expect(strip(view.container)).toBe("one.png:ready,two.png:ready");
  const [first, second] = hook.attachments;
  act(() => {
    hook.removeAttachment(first.id);
  });
  expect(hook.attachments.map((attachment) => attachment.id)).toEqual([
    second.id,
  ]);
  expect(strip(view.container)).toBe("two.png:ready");
});

test("the callbacks the composer memoises are stable across renders", async () => {
  render(
    <Probe
      config={{
        enabled: true,
        onUpload: async () => ({
          type: "data",
          value: "d",
          mimeType: "text/plain",
        }),
      }}
    />,
  );
  const first = {
    processFiles: hook.processFiles,
    removeAttachment: hook.removeAttachment,
    handleDragOver: hook.handleDragOver,
    handleDragLeave: hook.handleDragLeave,
  };
  // Several renders behind it: the placeholder, the upload resolving, and a config object handed
  // in afresh by this render's JSX.
  await process([image()]);
  expect(hook.processFiles).toBe(first.processFiles);
  expect(hook.removeAttachment).toBe(first.removeAttachment);
  expect(hook.handleDragOver).toBe(first.handleDragOver);
  expect(hook.handleDragLeave).toBe(first.handleDragLeave);
});

test("the attachment and config shapes are the card's, field for field", () => {
  // Compile-time. A field added, removed or renamed makes one of these `false`, which is an error
  // at the declaration rather than an expectation that quietly passes.
  const attachmentFields: Equal<
    keyof Attachment,
    "id" | "type" | "source" | "filename" | "size" | "status" | "metadata"
  > = true;
  const modality: Equal<
    Attachment["type"],
    "image" | "audio" | "video" | "document"
  > = true;
  const source: Equal<Attachment["source"]["type"], "url" | "data"> = true;
  const status: Equal<Attachment["status"], "uploading" | "ready" | "failed"> =
    true;
  const configFields: Equal<
    keyof AttachmentsConfig,
    "enabled" | "accept" | "maxSize" | "onUpload" | "onUploadFailed"
  > = true;
  // What a refusal hands the config's handler: the file to name and the sentence to read, and no
  // third field a handler would have to be told about.
  const refusal: Equal<keyof AttachmentUploadError, "file" | "message"> = true;

  // Runtime, in the same test: a config written the way the card writes it is accepted as-is.
  const normative: AttachmentsConfig = {
    enabled: true,
    accept: "image/*",
    maxSize: 1024,
    onUpload: async (file) => ({
      type: "url",
      value: `/api/attachments/${file.name}`,
    }),
    onUploadFailed: ({ file, message }) => {
      expect(file.name).toBeTruthy();
      expect(message).toBeTruthy();
    },
  };

  expect([
    attachmentFields,
    modality,
    source,
    status,
    configFields,
    refusal,
    normative.enabled,
  ]).toEqual([true, true, true, true, true, true, true]);
});

test("the first-party layer imports nothing from @copilotkit", () => {
  const layer = join(import.meta.dir, "..", "src", "lib", "agui");
  const offenders = readdirSync(layer)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .filter((name) =>
      readFileSync(join(layer, name), "utf8").includes("@copilotkit"),
    );
  expect(offenders).toEqual([]);
});
