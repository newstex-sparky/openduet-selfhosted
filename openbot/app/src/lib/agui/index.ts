/**
 * The first-party AG-UI client, as the app imports it.
 *
 * One module path stands where the vendor SDK's did, so a file that draws a card or binds a
 * conversation names this and nothing else. The wire protocol underneath is `@ag-ui/client`, which
 * is not a CopilotKit package: it is the AG-UI protocol's own client, and it is what the server
 * speaks on `/agent/:id/run` and `/agent/:id/connect`.
 */
export {
  RuntimeAgent,
  connectUrl,
  runUrl,
  stopUrl,
  type RuntimeAgentConfig,
} from "./agent";

export {
  CopilotKit,
  agentKey,
  unansweredToolCalls,
  type AgentLookup,
  type CopilotKitConfig,
  type CopilotKitSubscriber,
  type CopilotKitSubscription,
} from "./core";

export {
  CopilotChatConfigurationProvider,
  CopilotKitContext,
  CopilotKitProvider,
  useCopilotChatConfiguration,
  useCopilotKit,
  useDefaultAgentId,
  type CopilotChatConfigurationValue,
  type CopilotKitContextValue,
  type CopilotKitProviderProps,
} from "./context";

export {
  parseToolArguments,
  useAgent,
  useFrontendTool,
  useHumanInTheLoop,
  useRenderActivity,
  useRenderActivityMessage,
  useRenderTool,
  useRenderToolCall,
  type FrontendToolConfig,
  type UseAgentProps,
  type UseAgentResult,
} from "./hooks";

export {
  matchesAccept,
  useAttachments,
  type UseAttachmentsProps,
  type UseAttachmentsReturn,
} from "./attachments";

export { CopilotChat, type CopilotChatProps } from "./chat";

export {
  OpenGenerativeUIActivityRenderer,
  generatedDocument,
  type OpenGenerativeUIActivityRendererProps,
  type OpenGenerativeUIActivityType,
  type OpenGenerativeUIContent,
} from "./generative-ui";

export {
  ToolCallStatus,
  UseAgentUpdate,
  type AbstractAgent,
  type ActivityMessage,
  type Attachment,
  type AttachmentModality,
  type AttachmentUploadError,
  type AttachmentUploadErrorReason,
  type AttachmentUploadResult,
  type AttachmentsConfig,
  type AgentSubscriber,
  type FrontendTool,
  type FrontendToolHandlerContext,
  type HumanInTheLoopRenderProps,
  type Message,
  type ParametersOf,
  type ParametersSchema,
  type ReactActivityMessageRenderer,
  type ReactFrontendTool,
  type ReactHumanInTheLoop,
  type ReactToolCallRenderer,
  type RunAgentInput,
  type Tool,
  type ToolCall,
  type ToolRenderProps,
} from "./types";
