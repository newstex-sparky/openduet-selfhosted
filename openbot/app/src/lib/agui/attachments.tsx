/**
 * Files on the composer: pick, drop, paste, upload, remove.
 *
 * The bytes never enter React state. A config with `onUpload` gets the `File`, puts it somewhere
 * durable and hands back a reference, which is what the sent message carries; without one, the file
 * is read as a data URL, which is right for a small attachment and wrong for anything else.
 */
import { useCallback, useRef, useState } from "react";
import type {
  Attachment,
  AttachmentModality,
  AttachmentUploadError,
  AttachmentUploadResult,
  AttachmentsConfig,
} from "./types";

export interface UseAttachmentsProps {
  config?: AttachmentsConfig;
}

export interface UseAttachmentsReturn {
  /** Files chosen and not yet sent, uploading and ready together. */
  attachments: Attachment[];
  /** Whether this composer takes files at all. */
  enabled: boolean;
  /** Whether a file is being dragged over the composer. */
  dragOver: boolean;
  /** The hidden input a `+` button opens. */
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  /** Process files the composer picked up itself, such as a paste. */
  processFiles: (files: File[]) => Promise<void>;
  /** The input's own `onChange`. */
  handleFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleDragOver: (event: React.DragEvent) => void;
  handleDragLeave: (event: React.DragEvent) => void;
  handleDrop: (event: React.DragEvent) => Promise<void>;
  /** Take one back off the strip. */
  removeAttachment: (id: string) => void;
  /** Take every ready one, for a send that is about to carry them. */
  consumeAttachments: () => Attachment[];
}

/** A file's own name, for the strip and for the message that will carry it. */
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
 */
export function useAttachments({
  config,
}: UseAttachmentsProps): UseAttachmentsReturn {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const enabled = config?.enabled === true;
  // Read at call time: a config rebuilt on every render still answers with this render's policy.
  const current = useRef(config);
  current.current = config;

  const fail = useCallback(
    (reason: AttachmentUploadError["reason"], file: File, message: string) => {
      current.current?.onUploadFailed?.({ reason, file, message });
    },
    [],
  );

  const upload = useCallback(
    async (files: File[]): Promise<void> => {
      const settings = current.current;
      if (!settings?.enabled) return;
      for (const file of files) {
        if (!matchesAccept(file, settings.accept)) {
          fail("invalid-type", file, `"${file.name}" is not a kind of file this chat takes.`);
          continue;
        }
        if (settings.maxSize !== undefined && file.size > settings.maxSize) {
          fail("file-too-large", file, `"${file.name}" is too large to send.`);
          continue;
        }
        const id = `attachment-${crypto.randomUUID()}`;
        const placeholder: Attachment = {
          id,
          type: modalityOf(file),
          source: { type: "data", value: "" },
          filename: file.name,
          size: file.size,
          status: "uploading",
        };
        setAttachments((list) => [...list, placeholder]);
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
            "upload-failed",
            file,
            error instanceof Error
              ? error.message
              : `"${file.name}" could not be uploaded.`,
          );
        }
      }
    },
    [fail],
  );

  const processFiles = useCallback(
    async (files: File[]) => {
      await upload(files);
    },
    [upload],
  );

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = [...(event.target.files ?? [])];
      event.target.value = "";
      await upload(files);
    },
    [upload],
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!current.current?.enabled) return;
    event.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setDragOver(false);
      await upload([...event.dataTransfer.files]);
    },
    [upload],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((list) => list.filter((attachment) => attachment.id !== id));
  }, []);

  const consumeAttachments = useCallback(() => {
    const ready = attachments.filter(
      (attachment) => attachment.status === "ready",
    );
    if (attachments.length > 0) setAttachments([]);
    return ready;
  }, [attachments]);

  return {
    attachments,
    enabled,
    dragOver,
    fileInputRef,
    processFiles,
    handleFileUpload,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeAttachment,
    consumeAttachments,
  };
}

/** A file's bytes as a data URL, for a composer with no upload of its own. */
async function readAsDataUrl(file: File): Promise<AttachmentUploadResult> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`"${file.name}" could not be read.`));
    reader.readAsDataURL(file);
  });
  return { type: "data", value: dataUrl, mimeType: file.type };
}
