/**
 * The types the first-party AG-UI client speaks.
 *
 * These are declared here rather than imported from a vendor SDK so the app's rendering surface
 * (a tool's card, an activity, a file on the composer) has one owner. The wire types — `Message`,
 * `ToolCall`, `Interrupt` — are the protocol's and are re-exported from `@ag-ui/core` unchanged.
 */
import type { AbstractAgent, AgentSubscriber } from "@ag-ui/client";
import type {
  ActivityMessage,
  Message,
  RunAgentInput,
  Tool,
  ToolCall,
} from "@ag-ui/core";
import type { ReactNode } from "react";
import type * as z from "zod";

export type {
  AbstractAgent,
  ActivityMessage,
  AgentSubscriber,
  Message,
  RunAgentInput,
  Tool,
  ToolCall,
};

/**
 * Any zod schema. Kept as a named alias because it appears in the public surface of three hooks
 * and a caller that names it should not have to spell out zod's own generics.
 */
export type ParametersSchema = z.ZodType<Record<string, unknown>>;

/** A tool's arguments, as the schema that describes them says they are. */
export type ParametersOf<S extends ParametersSchema> = z.output<S>;

/**
 * Where a tool call stands. The names are the SDK's, because a card that switches on them reads
 * the same after the migration.
 */
export enum ToolCallStatus {
  /** Named, but its arguments are still arriving. */
  InProgress = "inProgress",
  /** The arguments are complete; the tool is running or waiting on a person. */
  Executing = "executing",
  /** It ran, and `result` is what it returned. */
  Complete = "complete",
}

/**
 * What a tool call's card is given.
 *
 * `parameters` is the schema-checked argument object for `executing` and `complete`, and a partial
 * one while arguments stream in. `args` carries the same value under the name the vendor SDK used,
 * so a card written against that name keeps working through the migration; both are the same
 * object, not two copies.
 */
export type ToolRenderProps<T> =
  | {
      name: string;
      toolCallId: string;
      parameters: Partial<T>;
      args: Partial<T>;
      status: ToolCallStatus.InProgress;
      result: undefined;
    }
  | {
      name: string;
      toolCallId: string;
      parameters: T;
      args: T;
      status: ToolCallStatus.Executing;
      result: undefined;
    }
  | {
      name: string;
      toolCallId: string;
      parameters: T;
      args: T;
      status: ToolCallStatus.Complete;
      result: string;
    };

/** A registered card for one tool's calls. */
export interface ReactToolCallRenderer<T = unknown> {
  name: string;
  /** Constrain the card to one agent. Absent means every agent. */
  agentId?: string;
  /** The schema the card was registered with, for the registry's own bookkeeping. */
  parameters?: ParametersSchema;
  /**
   * This card is how a person answers the call, not a view of something the server ran. A run that
   * calls it pauses, and the card's `respond` continues it.
   */
  humanInTheLoop?: boolean;
  /** The line shown beside the card, for a card that is a question. */
  description?: string;
  render: (props: ToolRenderProps<T>) => ReactNode;
}

/**
 * What a person-in-the-loop card is given, which is a tool call plus the way to answer it.
 *
 * `respond` resolves the interrupt this card was drawn for. It is present only while the run is
 * waiting: an answered card is `complete` and has nothing left to send.
 */
export type HumanInTheLoopRenderProps<T> =
  | {
      name: string;
      description: string;
      toolCallId: string;
      agentId?: string;
      parameters: Partial<T>;
      args: Partial<T>;
      status: ToolCallStatus.InProgress;
      result: undefined;
      respond: undefined;
    }
  | {
      name: string;
      description: string;
      toolCallId: string;
      agentId?: string;
      parameters: T;
      args: T;
      status: ToolCallStatus.Executing;
      result: undefined;
      respond: (result: unknown) => Promise<void>;
    }
  | {
      name: string;
      description: string;
      toolCallId: string;
      agentId?: string;
      parameters: T;
      args: T;
      status: ToolCallStatus.Complete;
      result: string;
      respond: undefined;
    };

/** What a registered activity message is drawn with. */
export interface ReactActivityMessageRenderer<TContent> {
  /** The activity type to match, or `"*"` for any. */
  activityType: string;
  agentId?: string;
  render: (props: {
    activityType: string;
    content: TContent;
    message: ActivityMessage;
    agent: AbstractAgent | undefined;
  }) => ReactNode;
}

/** What a client-side tool handler is given. */
export interface FrontendToolHandlerContext {
  /** Aborted when the person stops the turn. */
  signal: AbortSignal;
  toolCall: ToolCall;
  agent?: AbstractAgent;
}

/**
 * A tool the browser answers.
 *
 * `handler`'s own annotation is the contract for its arguments: the registry cannot infer a shape
 * through an arbitrary schema for a function it did not write, and every caller in this app
 * annotates what it expects. `parameters` is what the model is told, and what the card is typed
 * from.
 */
export interface FrontendTool<T extends Record<string, unknown>> {
  name: string;
  description: string;
  parameters: ParametersSchema;
  /**
   * Whether the model is offered this tool on this render. Absent means yes. A hook stays mounted
   * either way, so the number of hooks never changes with a query's answer.
   */
  available?: boolean;
  agentId?: string;
  handler?: (args: T, context: FrontendToolHandlerContext) => unknown | Promise<unknown>;
  /** The card for its calls, where a caller wants one registered with the tool. */
  render?: (props: ToolRenderProps<T>) => ReactNode;
}

/** A tool the browser answers, with its arguments named by the caller. */
export type ReactFrontendTool<
  T extends Record<string, unknown> = Record<string, unknown>,
> = FrontendTool<T>;

/** A tool that stops the run and puts a card in front of a person instead. */
export type ReactHumanInTheLoop<
  T extends Record<string, unknown> = Record<string, unknown>,
> = Omit<FrontendTool<T>, "handler"> & {
  render: (props: HumanInTheLoopRenderProps<T>) => ReactNode;
};

/** Which changes in an agent re-render the component that asked for it. */
export enum UseAgentUpdate {
  OnMessagesChanged = "OnMessagesChanged",
  OnStateChanged = "OnStateChanged",
  OnRunStatusChanged = "OnRunStatusChanged",
}

export type AttachmentModality = "image" | "audio" | "video" | "document";

/** What an upload hands back: a reference the sent message will carry. */
export type AttachmentUploadResult =
  | {
      type: "data";
      value: string;
      mimeType: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "url";
      value: string;
      mimeType?: string;
      metadata?: Record<string, unknown>;
    };

export type AttachmentUploadErrorReason =
  | "file-too-large"
  | "invalid-type"
  | "upload-failed";

export interface AttachmentUploadError {
  reason: AttachmentUploadErrorReason;
  file: File;
  /** The sentence a person reads. */
  message: string;
}

/** One file in the composer, while it uploads and once it is ready to send. */
export interface Attachment {
  /** A client-side handle for the placeholder, not the stored row's id. */
  id: string;
  type: AttachmentModality;
  source: { type: "url" | "data"; value: string; mimeType?: string };
  filename?: string;
  size?: number;
  status: "uploading" | "ready" | "failed";
  metadata?: Record<string, unknown>;
}

/** How one composer takes files. */
export interface AttachmentsConfig {
  /** Whether the composer accepts files at all. */
  enabled: boolean;
  /** A MIME filter for the file input. `"*​/*"` accepts everything. */
  accept?: string;
  /** The largest file accepted, in bytes. */
  maxSize?: number;
  /** Upload one file. Its answer is what the sent message will carry. */
  onUpload?: (file: File) => Promise<AttachmentUploadResult>;
  /** Validation or upload failed. */
  onUploadFailed?: (error: AttachmentUploadError) => void;
}
