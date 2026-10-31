/**
 * The first-party AG-UI client, as the app imports it.
 *
 * One module path stands where the vendor SDK's did, so a file that draws a card or binds a
 * conversation names this and nothing else. The wire protocol underneath is `@ag-ui/client`, which
 * is not a CopilotKit package: it is the AG-UI protocol's own client, and it is what the server
 * speaks on `/agent/:id/run` and `/agent/:id/connect`.
 */
export {
  connectUrl,
  RuntimeAgent,
  type RuntimeAgentConfig,
  runUrl,
  stopUrl,
} from "./agent";
export {
  matchesAccept,
  type UseAttachmentsProps,
  type UseAttachmentsReturn,
  useAttachments,
} from "./attachments";
export { CopilotChat, type CopilotChatProps } from "./chat";
export {
  CopilotChatConfigurationProvider,
  type CopilotChatConfigurationValue,
  CopilotKitContext,
  type CopilotKitContextValue,
  CopilotKitProvider,
  type CopilotKitProviderProps,
  useCopilotChatConfiguration,
  useCopilotKit,
  useDefaultAgentId,
} from "./context";
export {
  type AgentLookup,
  agentKey,
  CopilotKit,
  type CopilotKitConfig,
  type CopilotKitSubscriber,
  type CopilotKitSubscription,
  unansweredToolCalls,
} from "./core";
export {
  activityProgress,
  generatedDocument,
  generativeUIActivityRenderers,
  OpenGenerativeUIActivityRenderer,
  type OpenGenerativeUIActivityRendererProps,
  type OpenGenerativeUIActivityType,
  type OpenGenerativeUIContent,
  type OpenGenerativeUIProgress,
} from "./generative-ui";
export {
  type FrontendToolConfig,
  parseToolArguments,
  type UseAgentProps,
  type UseAgentResult,
  useAgent,
  useFrontendTool,
  useHumanInTheLoop,
  useRenderActivity,
  useRenderActivityMessage,
  useRenderTool,
  useRenderToolCall,
} from "./hooks";

export {
  type AbstractAgent,
  type ActivityMessage,
  type AgentSubscriber,
  type Attachment,
  type AttachmentModality,
  type AttachmentsConfig,
  type AttachmentUploadError,
  type AttachmentUploadResult,
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
  ToolCallStatus,
  type ToolRenderProps,
  UseAgentUpdate,
} from "./types";
