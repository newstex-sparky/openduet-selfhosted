/**
 * Files on the composer: pick, drop, paste, upload, remove.
 *
 * The bytes never enter React state. A config with `onUpload` gets the `File`, puts it somewhere
 * durable and hands back a reference, which is what the sent message carries; without one, the file
 * is read as a data URL, which is right for a small attachment and wrong for anything else.
 *
 * THE RETURNED SHAPE IS THE CONTRACT, AND IT IS SEVEN NAMES. `attachments`, `enabled`,
 * `fileInputRef`, `processFiles`, `handleDragOver`, `handleDragLeave`, `removeAttachment` — nothing
 * else. There is no hover flag, no drop handler and no sweep: the composer screens its own drops
 * and picks, the file input carries its own `onChange`, and taking a chip off the strip is one id
 * at a time so a send in flight keeps the attachment it is riding. A caller that wants a different
 * shape writes the difference itself rather than finding it here.
 */
import { useCallback, useRef, useState } from "react";
import { newId } from "@/lib/new-id";
import type {
  Attachment,
  AttachmentModality,
  AttachmentsConfig,
  AttachmentUploadResult,
} from "./types";

export interface UseAttachmentsProps {
  config?: AttachmentsConfig;
}

export interface UseAttachmentsReturn {
  /** Files chosen and not yet sent, uploading and ready together. */
  attachments: Attachment[];
  /** Whether this composer takes files at all. */
  enabled: boolean;
  /** The hidden input a `+` button opens. */
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  /** Process files the composer picked up itself, such as a paste or a drop. */
  processFiles: (files: File[]) => Promise<void>;
  /** Keep a dragged file over the composer: without this the element is not a drop target. */
  handleDragOver: (event: React.DragEvent) => void;
  /** The pointer left, or moved between children of the same composer. */
  handleDragLeave: (event: React.DragEvent) => void;
  /** Take one back off the strip. */
  removeAttachment: (id: string) => void;
}

/** A file's own kind, for the strip and for the message that will carry it. */
function modalityOf(file: File): AttachmentModality {
  const declared = file.type;
  if (declared.startsWith("image/")) return "image";
  if (declared.startsWith("audio/")) return "audio";
  if (declared.startsWith("video/")) return "video";
  // The browser's claim is a hint, not a fact: an extension it has no mapping for arrives as
  // `application/octet-stream`, which the server sniffs for itself.
  return "document";
}

/**
 * Whether a file passes the config's `accept`.
 *
 * A leading dot is a filename suffix and a slash is a media type, and both are read the way a file
 * dialog reads them, so the composer's own gate and the dialog's greying-out agree.
 */
export function matchesAccept(file: File, accept: string | undefined): boolean {
  if (!accept || accept.trim() === "" || accept.trim() === "*/*") return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept.split(",").some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith(".")) return name.endsWith(rule);
    if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

/**
 * One composer's files.
 *
 * A file that fails validation or upload never joins the strip: `onUploadFailed` is the composer's
 * to report, in its own words, and a placeholder it cannot send would sit there looking like
 * something waiting for a caption.
 *
 * DISABLED IS A STATE, NOT AN ERROR. With no config, or a config that says `enabled: false`, the
 * hook holds an empty strip, uploads nothing it is handed, and refuses to be a drop target. It is
 * called unconditionally by every composer — the channel is what turns files on, and a hook that
 * threw or read a context would make that a conditional hook call.
 */
export function useAttachments({
  config,
}: UseAttachmentsProps): UseAttachmentsReturn {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const enabled = config?.enabled === true;
  // Read at call time: a config rebuilt on every render still answers with this render's policy,
  // and every callback below can stay stable for the life of the hook. The composer hangs its own
  // memos off `processFiles` and `removeAttachment`, so an identity that changed per render would
  // rebuild the whole prompt area on every keystroke's worth of state.
  const current = useRef(config);
  current.current = config;

  const fail = useCallback((file: File, message: string) => {
    current.current?.onUploadFailed?.({ file, message });
  }, []);

  /**
   * ONE UPLOAD IN THE AIR AT A TIME, ACROSS BATCHES.
   *
   * A drop and a pick can arrive while the first file is still uploading. Letting the second
   * upload start at once would leave two in the air, and the composer reconciles its rows only
   * when nothing is uploading — with two pending it can see neither finish, so a chip removed
   * mid-upload never gives its row back. The placeholder still goes on the strip the moment the
   * file is taken, because the strip is what shows a person what they picked; only the request
   * waits its turn behind the one before it.
   */
  const uploadSlot = useRef<Promise<void>>(Promise.resolve());

  const processFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const settings = current.current;
      if (!settings?.enabled) return;
      const uploads: Promise<void>[] = [];
      for (const file of files) {
        if (!matchesAccept(file, settings.accept)) {
          fail(file, `"${file.name}" is not a kind of file this chat takes.`);
          continue;
        }
        if (settings.maxSize !== undefined && file.size > settings.maxSize) {
          fail(file, `"${file.name}" is too large to send.`);
          continue;
        }
        const id = `attachment-${newId()}`;
        const placeholder: Attachment = {
          id,
          type: modalityOf(file),
          source: { type: "data", value: "" },
          filename: file.name,
          size: file.size,
          status: "uploading",
        };
        setAttachments((list) => [...list, placeholder]);
        const upload = uploadSlot.current.then(async () => {
          try {
            const result = settings.onUpload
              ? await settings.onUpload(file)
              : await readAsDataUrl(file);
            setAttachments((list) =>
              list.map((attachment) =>
                attachment.id === id
                  ? {
                      ...attachment,
                      type: modalityOf(file),
                      source:
                        result.type === "url"
                          ? {
                              type: "url",
                              value: result.value,
                              ...(result.mimeType === undefined
                                ? {}
                                : { mimeType: result.mimeType }),
                            }
                          : {
                              type: "data",
                              value: result.value,
                              ...(result.mimeType === undefined
                                ? {}
                                : { mimeType: result.mimeType }),
                            },
                      status: "ready",
                      ...(result.metadata === undefined
                        ? {}
                        : { metadata: result.metadata }),
                    }
                  : attachment,
              ),
            );
          } catch (error) {
            // Gone from the strip before it is reported, so what is said and what is shown cannot
            // disagree about a file nobody can send.
            setAttachments((list) =>
              list.filter((attachment) => attachment.id !== id),
            );
            fail(
              file,
              error instanceof Error
                ? error.message
                : `"${file.name}" could not be uploaded.`,
            );
          }
        });
        uploadSlot.current = upload.then(
          () => undefined,
          () => undefined,
        );
        uploads.push(upload);
      }
      await Promise.all(uploads);
    },
    [fail],
  );

  /**
   * A FILE IS OVER THE COMPOSER: TELL THE BROWSER TO KEEP IT.
   *
   * `preventDefault` on a dragover is the whole of what makes an element a drop target. With no
   * handler — or a handler that declines — `drop` never fires and the browser performs its own
   * default for a file let go over a document, which is to NAVIGATE THE PAGE TO THAT FILE and take
   * the conversation with it. `stopPropagation` keeps a container's own highlights from fighting
   * over nesting: the innermost composer that can take the file is the one that answers.
   */
  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!current.current?.enabled) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  /**
   * THE POINTER LEFT, OR MOVED BETWEEN CHILDREN OF THE SAME COMPOSER.
   *
   * Nothing is drawn from a hover state — the returned contract has no flag for one — so this
   * cannot put a highlight down. It stops where it is: a drag that crosses from the strip to the
   * text box has not left the composer, and a caller with its own drop surface above this one must
   * not be told that it has. `preventDefault` is deliberately absent; a dragleave has no default
   * action, and cancelling one is how an overlay starts flickering.
   */
  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.stopPropagation();
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((list) => list.filter((attachment) => attachment.id !== id));
  }, []);

  return {
    attachments,
    enabled,
    fileInputRef,
    processFiles,
    handleDragOver,
    handleDragLeave,
    removeAttachment,
  };
}

/** A file's bytes as a data URL, for a composer with no upload of its own. */
async function readAsDataUrl(file: File): Promise<AttachmentUploadResult> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () =>
      reject(new Error(`"${file.name}" could not be read.`));
    reader.readAsDataURL(file);
  });
  return { type: "data", value: dataUrl, mimeType: file.type };
}
