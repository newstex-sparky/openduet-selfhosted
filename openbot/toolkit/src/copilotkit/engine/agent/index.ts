import { RENDER_A2UI_TOOL } from "@ag-ui/a2ui-middleware";
import {
  AbstractAgent,
  type AgentCapabilities,
  type BaseEvent,
  EventType,
  type Interrupt,
  type Message,
  PROTOCOL_VERSION,
  type ResumeEntry,
  type RunAgentInput,
} from "@ag-ui/client";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import { Validator } from "@cfworker/json-schema";
import {
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolChoice,
  type ToolSet,
  tool,
} from "ai";
import { Observable } from "rxjs";
import { z } from "zod";
import {
  formatToolError,
  getAISDKRunFinishedDetails,
  resolveStreamPartMessageId,
} from "./converters/aisdk";
import { getNonEmptyString, isRecord } from "./converters/usage";
import { classifyModelHost, type ModelHostClass } from "./model-host";
import { createStateEventNormalizer } from "./state-delta";

/**
 * A built-in Bot: an AG-UI agent whose whole answer is a model call this process makes.
 *
 * Ported from the CopilotKit runtime package, 1.77.0 (`dist/agent/index.mjs`, MIT), which this repository
 * stops depending on in Phase 6. What is kept is what this fork actually runs — the classic model
 * path (`model`, `prompt`, `apiKey`, `tools`, `maxSteps`) and factory mode for a caller that owns
 * the model call (`type:"custom"` + `factory`, which `builtInAgentConfiguration` uses for a Bot
 * with no API key and for a plan model). What is dropped, because nothing in this repository
 * reaches it and an unused branch is a branch nobody tests:
 *
 * - `mcpServers` / `mcpClients` — the fork offers tools through its own plugin store, which
 *   checks the grant, the policy and the audit row. A vendor MCP path would walk around all three.
 * - `overridableProperties` and the `forwardedProps` overrides — no configuration here sets it.
 * - `learnedSkills` (the vendor's SkillRegistry) — `copilot.ts` injects a learned Skill's catalog
 *   into the prompt and its tools into the tool list itself.
 * - the `type:"aisdk"` and `type:"tanstack"` factories — no caller. The AG-UI event conversion and
 *   the usage accounting that the classic path shares with them are kept in `./converters`.
 *
 * EVERYTHING BELOW IS BEHAVIOUR THIS FORK DEPENDS ON, not a shape that merely compiles: the
 * per-run abort controller that makes a concurrent run refuse rather than interleave, the message
 * id rule that keeps repeated provider ids from appending to an earlier reply, the reasoning
 * lifecycle that some providers never close, and the state snapshot that has to precede the first
 * delta.
 */

/** Supported model identifiers for BuiltInAgent. */
export type BuiltInAgentModel =
  | "openai/gpt-5"
  | "openai/gpt-5-mini"
  | "openai/gpt-4.1"
  | "openai/gpt-4.1-mini"
  | "openai/gpt-4.1-nano"
  | "openai/gpt-4o"
  | "openai/gpt-4o-mini"
  | "openai/o3"
  | "openai/o3-mini"
  | "openai/o4-mini"
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-sonnet-4-5"
  | "anthropic/claude-opus-4-8"
  | "anthropic/claude-haiku-4-5"
  | "google/gemini-2.5-pro"
  | "google/gemini-2.5-flash"
  | "google/gemini-2.5-flash-lite"
  | "minimax/MiniMax-M3"
  | "minimax/MiniMax-M2.7"
  | (string & {});

/** Model specifier - can be a string like "openai/gpt-4o" or a LanguageModel instance. */
export type ModelSpecifier = string | LanguageModel;

/** What every Standard Schema V1 library (Zod, Valibot, ArkType) exposes on its schemas. */
export type StandardSchemaV1<TInput = unknown, TOutput = TInput> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => unknown;
    readonly types?:
      | { readonly input: TInput; readonly output: TOutput }
      | undefined;
  };
};

export type InferSchemaOutput<S> =
  S extends StandardSchemaV1<unknown, infer O> ? O : never;

/** A tool's input schema, in JSON Schema form, as AG-UI carries it. */
export type JsonSchema = {
  type?:
    | "object"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "array"
    | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

/** A tool this Bot executes itself, defined in its configuration. */
export type ToolDefinition<
  TParameters extends StandardSchemaV1 = StandardSchemaV1,
> = {
  name: string;
  description: string;
  parameters: TParameters;
  /**
   * Server-side executor. Optional ONLY for interrupt tools (`interrupt:true`), which pause the
   * run instead of executing.
   */
  execute?: (args: InferSchemaOutput<TParameters>) => Promise<unknown>;
  /**
   * When true, calling this tool pauses the run and emits a standard AG-UI interrupt
   * (RUN_FINISHED outcome:interrupt) keyed by the tool call's id. The human response (resume
   * payload) is injected as this tool call's result on the resume run. Interrupt tools must NOT
   * define `execute`. The AI SDK pauses when a tool call has no result, even with a multi-step
   * limit.
   */
  interrupt?: boolean;
  /** Optional categorical reason surfaced on the Interrupt (default: "tool_call"). */
  interruptReason?: string;
  /** Optional human-readable prompt surfaced on the Interrupt. */
  interruptMessage?: string;
};

/** Define a tool for use with BuiltInAgent. */
export function defineTool<TParameters extends StandardSchemaV1>(config: {
  name: string;
  description: string;
  parameters: TParameters;
  execute?: (args: InferSchemaOutput<TParameters>) => Promise<unknown>;
  interrupt?: boolean;
  interruptReason?: string;
  interruptMessage?: string;
}): ToolDefinition<TParameters> {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute,
    interrupt: config.interrupt,
    interruptReason: config.interruptReason,
    interruptMessage: config.interruptMessage,
  };
}

/**
 * Resolves a model specifier to a LanguageModel instance.
 *
 * The base URL of each provider comes from the environment, which is how a deployment points a
 * provider at a gateway, a proxy or a laptop. `classifyModelSpec` reads the same variables and
 * must stay in step with this switch.
 */
export function resolveModel(
  spec: ModelSpecifier,
  apiKey?: string,
): LanguageModel {
  if (typeof spec !== "string") return spec;
  const parts = spec.replace("/", ":").trim().split(":");
  const rawProvider = parts[0];
  const rest = parts.slice(1);
  if (!rawProvider)
    throw new Error(
      `Invalid model string "${spec}". Use "openai/gpt-5", "anthropic/claude-sonnet-4.5", or "google/gemini-2.5-pro".`,
    );
  const provider = rawProvider.toLowerCase();
  const model = rest.join(":").trim();
  if (!model)
    throw new Error(
      `Invalid model string "${spec}". Use "openai/gpt-5", "anthropic/claude-sonnet-4.5", or "google/gemini-2.5-pro".`,
    );
  switch (provider) {
    case "openai":
      return createOpenAI({
        apiKey: apiKey || process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
      })(model);
    case "anthropic":
      return createAnthropic({
        apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
        baseURL: process.env.ANTHROPIC_BASE_URL,
      })(model);
    case "google":
    case "gemini":
    case "google-gemini":
      return createGoogleGenerativeAI({
        apiKey: apiKey || process.env.GOOGLE_API_KEY,
        baseURL: process.env.GOOGLE_GENERATIVE_AI_BASE_URL,
      })(model);
    case "minimax":
      return createOpenAI({
        name: "minimax",
        apiKey: apiKey || process.env.MINIMAX_API_KEY,
        baseURL: process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1",
      })(model);
    case "vertex":
      return createVertex()(model);
    default:
      throw new Error(
        `Unknown provider "${provider}" in "${spec}". Supported: openai, anthropic, google (gemini).`,
      );
  }
}

/** Which vendor a model specifier will actually reach. See {@link classifyModelHost}. */
export function classifyModelSpec(spec: ModelSpecifier): ModelHostClass {
  if (typeof spec !== "string") return "unknown";
  switch (spec.replace("/", ":").trim().split(":")[0]?.toLowerCase()) {
    case "openai":
      return classifyModelHost(process.env.OPENAI_BASE_URL, "openai");
    case "anthropic":
      return classifyModelHost(process.env.ANTHROPIC_BASE_URL, "anthropic");
    case "google":
    case "gemini":
    case "google-gemini":
      return classifyModelHost(
        process.env.GOOGLE_GENERATIVE_AI_BASE_URL,
        "google",
      );
    case "minimax":
      return classifyModelHost(
        process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1",
        "minimax",
      );
    case "vertex":
      return "vertex";
    default:
      return "unknown";
  }
}

/**
 * Thrown by `AgentFactoryContext.interrupt()` on a fresh (non-resume) run to pause the factory.
 * Caught in `runFactory` and translated into a RUN_FINISHED event carrying
 * `outcome:{type:"interrupt",interrupts}`. Not a real error.
 */
export class InterruptSignal extends Error {
  readonly interrupts: Interrupt[];
  constructor(interrupts: Interrupt[]) {
    super("interrupt: run paused awaiting human input");
    this.interrupts = interrupts;
    this.name = "InterruptSignal";
  }
}

/** Context passed to the user-supplied factory function in factory mode. */
export type AgentFactoryContext = {
  input: RunAgentInput;
  /**
   * Prefer `abortSignal` for most use cases (AI SDK, fetch, custom backends). Do NOT call
   * `.abort()` on this controller — use `abortRun()` on the agent instead.
   */
  abortController: AbortController;
  abortSignal: AbortSignal;
  /**
   * Pause the run for human input (AG-UI standard interrupt). On a fresh run this throws an
   * InterruptSignal (caught here) and the run finishes with `outcome:{type:"interrupt",interrupts}`.
   * On the resume run (when `input.resume` covers these interrupts) it returns the matching
   * ResumeEntry responses so the factory can continue. Each `interrupts[i].id` is matched to
   * `input.resume[].interruptId`.
   */
  interrupt: (interrupts: Interrupt[]) => Promise<ResumeEntry[]>;
};

/** Public name that avoids the runtime's request-scoped AgentFactoryContext. */
export type BuiltInAgentFactoryContext = AgentFactoryContext;

/** Factory config for a custom backend that directly yields AG-UI events. */
export type BuiltInAgentCustomFactoryConfig = {
  type: "custom";
  factory: (
    ctx: AgentFactoryContext,
  ) => AsyncIterable<BaseEvent> | Promise<AsyncIterable<BaseEvent>>;
};

/** Classic config — BuiltInAgent handles streamText, tools, state tools and prompt building. */
export type BuiltInAgentClassicConfig = {
  /** The model to use. */
  model: BuiltInAgentModel | LanguageModel;
  /** API key for the model provider. Falls back to the provider's environment variable. */
  apiKey?: string;
  /** Maximum number of steps/iterations for tool calling (default: 1). */
  maxSteps?: number;
  /** Tool choice setting - how tools are selected for execution (default: "auto"). */
  toolChoice?: ToolChoice<Record<string, unknown>>;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
  maxRetries?: number;
  /** Prompt for the agent. */
  prompt?: string;
  /** Optional tools available to the agent. */
  tools?: ToolDefinition[];
  /**
   * Forward system-role messages from input to the LLM. Default: false.
   *
   * False is the fork's whole position: the system prompt is assembled here, from the Bot's role
   * and the run's context, and a system message a client sent is not an instruction the deployment
   * wrote.
   */
  forwardSystemMessages?: boolean;
  /** Forward developer-role messages from input to the LLM (as system messages). Default: false. */
  forwardDeveloperMessages?: boolean;
  /** Provider-specific options passed to the model (e.g., OpenAI reasoningEffort). */
  providerOptions?: Parameters<typeof streamText>[0]["providerOptions"];
  /** Explicit agent capabilities, shallow-merged at the category level over the inferred ones. */
  capabilities?: Partial<AgentCapabilities>;
};

/**
 * Configuration for BuiltInAgent.
 *
 * Two modes:
 * - **Classic** (model + params): BuiltInAgent handles everything — streamText, tools, state tools.
 * - **Factory** (type + factory): you own the LLM call. BuiltInAgent handles lifecycle only.
 */
export type BuiltInAgentConfiguration =
  | BuiltInAgentClassicConfig
  | BuiltInAgentCustomFactoryConfig;

/** Options for converting AG-UI messages to Vercel AI SDK format. */
export type MessageConversionOptions = {
  forwardSystemMessages?: boolean;
  forwardDeveloperMessages?: boolean;
};

/**
 * An AG-UI tool result as the AI SDK's tool result output.
 *
 * Providers hold one response per tool call, and the Google adapter emits one functionResponse per
 * text entry of a content list, so all of a result's text is collected into a single entry: text
 * parts run together, and a URL-referenced part contributes the URL it carries on a line of its
 * own — the bytes are not here to hand over, and the reference is the content the tool actually
 * returned. A result with no inline media is that text alone. One with inline media is a content
 * list: the text entry first, when there is any, then each media part with its bytes and media
 * type. A media-only result is media alone: a placeholder text would be content the tool never
 * returned.
 *
 * A provider file handle (`file` source) is neither bytes nor a URL, and this path cannot hand it
 * to the provider, so the part is dropped with a warning. A result whose parts were all dropped is
 * the empty string, as AG-UI 1.0 requires: the call must still be answered.
 */
function warnDroppedFileSource(what: string): void {
  console.warn(
    `[agent] Dropping a ${what} that references a provider file handle: it is not a URL or inline data, so it cannot be sent to the model here.`,
  );
}

type ToolResultPartLike = {
  type: string;
  text?: string;
  source: { type: "data" | "url" | "file"; value: string; mimeType?: string };
};

function toolResultOutput(content: string | readonly ToolResultPartLike[]): {
  type: "text" | "content";
  value: unknown;
} {
  if (typeof content === "string") return { type: "text", value: content };
  const segments: string[] = [];
  const media: { type: "media"; data: string; mediaType?: string }[] = [];
  let open = false;
  for (const part of content) {
    if (part.type === "text") {
      if (open) segments[segments.length - 1] += part.text ?? "";
      else if (part.text !== undefined) segments.push(part.text);
      open = true;
    } else if (part.source.type === "file")
      warnDroppedFileSource(`${part.type} part in a tool result`);
    else if (part.source.type === "url") {
      segments.push(part.source.value);
      open = false;
    } else {
      media.push({
        type: "media",
        data: part.source.value,
        mediaType: part.source.mimeType,
      });
      open = false;
    }
  }
  const text = segments.join("\n");
  if (media.length === 0) return { type: "text", value: text };
  return {
    type: "content",
    value: [...(text.length > 0 ? [{ type: "text", text }] : []), ...media],
  };
}

/**
 * Converts AG-UI user message content to Vercel AI SDK UserContent format.
 *
 * Handles plain strings, new modality-specific parts (image/audio/video/document), and legacy
 * BinaryInputContent for backward compatibility.
 */
function convertUserMessageContent(
  content: Message["content"],
): string | unknown[] {
  if (!content) return "";
  if (typeof content === "string") return content;
  const parts: unknown[] = [];
  for (const part of content as unknown as readonly unknown[]) {
    if (!part || typeof part !== "object" || !("type" in part)) continue;
    switch (part.type) {
      case "text": {
        const text = (part as { text?: string }).text;
        if (text) parts.push({ type: "text", text });
        break;
      }
      case "image": {
        const source = (part as { source?: ToolResultPartLike["source"] })
          .source;
        if (!source) break;
        if (source.type === "data")
          parts.push({
            type: "image",
            image: source.value,
            mediaType: source.mimeType,
          });
        else if (source.type === "file") warnDroppedFileSource("image part");
        else if (source.type === "url")
          try {
            parts.push({
              type: "image",
              image: new URL(source.value),
              mediaType: source.mimeType,
            });
          } catch {
            console.error(
              `[agent] convertUserMessageContent: invalid URL "${source.value}" in image part — skipping`,
            );
          }
        break;
      }
      case "audio":
      case "video":
      case "document": {
        const source = (part as { source?: ToolResultPartLike["source"] })
          .source;
        if (!source) break;
        if (source.type === "data")
          parts.push({
            type: "file",
            data: source.value,
            mediaType: source.mimeType,
          });
        else if (source.type === "file")
          warnDroppedFileSource(`${part.type} part`);
        else if (source.type === "url")
          try {
            parts.push({
              type: "file",
              data: new URL(source.value),
              mediaType: source.mimeType ?? "application/octet-stream",
            });
          } catch {
            console.error(
              `[agent] convertUserMessageContent: invalid URL "${source.value}" in ${part.type} part — skipping`,
            );
          }
        break;
      }
      case "binary": {
        const legacy = part as {
          mimeType?: string;
          data?: string;
          url?: string;
        };
        const mimeType = legacy.mimeType ?? "application/octet-stream";
        const isImage = mimeType.startsWith("image/");
        if (legacy.data)
          if (isImage)
            parts.push({
              type: "image",
              image: legacy.data,
              mediaType: mimeType,
            });
          else
            parts.push({
              type: "file",
              data: legacy.data,
              mediaType: mimeType,
            });
        else if (legacy.url)
          try {
            const url = new URL(legacy.url);
            if (isImage)
              parts.push({ type: "image", image: url, mediaType: mimeType });
            else parts.push({ type: "file", data: url, mediaType: mimeType });
          } catch {
            console.error(
              `[agent] convertUserMessageContent: invalid URL "${legacy.url}" in binary part — skipping`,
            );
          }
        break;
      }
      default:
        console.error(
          `[agent] convertUserMessageContent: unrecognized content part type "${(part as { type: string }).type}" — skipping`,
        );
        break;
    }
  }
  return parts.length > 0 ? parts : "";
}

/** Parses a tool call's arguments without letting bad JSON end the conversation. */
export function safeParseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    console.warn(
      `[agent] Tool arguments parsed to non-object (${typeof parsed}), falling back to empty object`,
    );
    return {};
  } catch {
    console.warn(
      "[agent] Failed to parse tool arguments, falling back to empty object",
    );
    return {};
  }
}

/**
 * Converts AG-UI messages to Vercel AI SDK ModelMessage format.
 *
 * A tool message's tool name is recovered from the assistant message that made the call, because
 * AG-UI carries only the call id on a result and the AI SDK's providers want both.
 */
export function convertMessagesToVercelAISDKMessages(
  messages: Message[],
  options: MessageConversionOptions = {},
): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const message of messages)
    if (message.role === "system" && options.forwardSystemMessages) {
      result.push({ role: "system", content: message.content ?? "" });
    } else if (
      message.role === "developer" &&
      options.forwardDeveloperMessages
    ) {
      result.push({ role: "system", content: message.content ?? "" });
    } else if (message.role === "assistant") {
      const parts: Record<string, unknown>[] = message.content
        ? [{ type: "text", text: message.content }]
        : [];
      for (const toolCall of message.toolCalls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input: safeParseToolArgs(toolCall.function.arguments),
        });
      }
      result.push({
        role: "assistant",
        content: parts,
      } as unknown as ModelMessage);
    } else if (message.role === "user") {
      result.push({
        role: "user",
        content: convertUserMessageContent(message.content),
      } as unknown as ModelMessage);
    } else if (message.role === "tool") {
      let toolName = "unknown";
      for (const msg of messages)
        if (msg.role === "assistant") {
          for (const toolCall of msg.toolCalls ?? [])
            if (toolCall.id === message.toolCallId) {
              toolName = toolCall.function.name;
              break;
            }
        }
      result.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName,
            output: toolResultOutput(
              message.content as unknown as
                | readonly ToolResultPartLike[]
                | string,
            ),
          },
        ],
      } as unknown as ModelMessage);
    }
  return result;
}

/** Converts JSON Schema to a Zod schema, for a caller that wants one. */
export function convertJsonSchemaToZodSchema(
  jsonSchema: JsonSchema,
  required: boolean,
): z.ZodType {
  if (jsonSchema.type === "null") {
    const schema = z.null().describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  }
  const unionVariants = jsonSchema.anyOf ?? jsonSchema.oneOf;
  if (Array.isArray(unionVariants) && unionVariants.length > 0) {
    if (unionVariants.length === 1)
      return convertJsonSchemaToZodSchema(unionVariants[0], required);
    const variantSchemas = unionVariants.map((variant) =>
      convertJsonSchemaToZodSchema(variant, true),
    );
    const schema = z
      .union(
        variantSchemas as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]],
      )
      .describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  }
  if (!jsonSchema.type)
    return required ? z.object({}) : z.object({}).optional();
  if (jsonSchema.type === "object") {
    const spec: Record<string, z.ZodType> = {};
    if (!jsonSchema.properties || !Object.keys(jsonSchema.properties).length)
      return !required ? z.object(spec).optional() : z.object(spec);
    for (const [key, value] of Object.entries(jsonSchema.properties))
      spec[key] = convertJsonSchemaToZodSchema(
        value,
        jsonSchema.required ? jsonSchema.required.includes(key) : false,
      );
    const schema = z.object(spec).describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "string") {
    if (jsonSchema.enum && jsonSchema.enum.length > 0) {
      const schema = z
        .enum(jsonSchema.enum as [string, ...string[]])
        .describe(jsonSchema.description ?? "");
      return required ? schema : schema.optional();
    }
    const schema = z.string().describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "number" || jsonSchema.type === "integer") {
    const schema = z.number().describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "boolean") {
    const schema = z.boolean().describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "array") {
    if (!jsonSchema.items)
      throw new Error("Array type must have items property");
    const itemSchema = convertJsonSchemaToZodSchema(jsonSchema.items, true);
    const schema = z.array(itemSchema).describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  }
  console.error("Invalid JSON schema:", JSON.stringify(jsonSchema, null, 2));
  throw new Error("Invalid JSON schema");
}

function isJsonSchema(obj: unknown): obj is JsonSchema {
  if (typeof obj !== "object" || obj === null) return false;
  const schema = obj as JsonSchema;
  if (Object.keys(schema).length === 0) return true;
  return (
    typeof schema.type === "string" &&
    ["object", "string", "number", "integer", "boolean", "array"].includes(
      schema.type,
    )
  );
}

/**
 * Preserves AG-UI tool schemas when passing them to the model provider.
 *
 * The validator is the AI SDK's own hook: a call whose arguments do not satisfy the schema the
 * client declared fails as a tool error where the tool is, rather than reaching the model as
 * something the tool never agreed to accept.
 */
export function convertToolsToVercelAITools(
  tools: RunAgentInput["tools"],
): ToolSet {
  const result: ToolSet = {};
  for (const agentTool of tools) {
    if (!isJsonSchema(agentTool.parameters))
      throw new Error(`Invalid JSON schema for tool ${agentTool.name}`);
    const validator = new Validator(agentTool.parameters, "7");
    result[agentTool.name] = tool({
      description: agentTool.description,
      inputSchema: jsonSchema(agentTool.parameters, {
        validate: (value: unknown) => {
          return validator.validate(value).valid
            ? { success: true, value }
            : {
                success: false,
                error: new Error(
                  `Invalid arguments for tool ${agentTool.name}`,
                ),
              };
        },
      }),
      ...(agentTool.name === RENDER_A2UI_TOOL.name ? { strict: false } : {}),
    });
  }
  return result;
}

/** Check whether a schema is a Zod schema by inspecting its Standard Schema vendor. */
function isZodSchema(schema: unknown): boolean {
  return (
    (schema as { "~standard"?: { vendor?: string } })["~standard"]?.vendor ===
    "zod"
  );
}

/**
 * Convert any StandardSchemaV1-compatible schema to a JSON Schema object.
 *
 * 1. If the schema implements Standard JSON Schema V1 (`~standard.jsonSchema`), call it.
 * 2. If the schema exposes a `toJSONSchema()` method (Zod v4), call it directly.
 * 3. Otherwise throw, rather than pretending a tool takes nothing.
 */
export function schemaToJsonSchema(schema: unknown): Record<string, unknown> {
  const standard = (
    schema as {
      "~standard"?: {
        vendor?: string;
        jsonSchema?: { input?: (options?: unknown) => Record<string, unknown> };
      };
      toJSONSchema?: () => Record<string, unknown>;
    }
  )["~standard"];
  if (
    standard?.jsonSchema &&
    typeof standard.jsonSchema === "object" &&
    typeof standard.jsonSchema.input === "function"
  )
    return standard.jsonSchema.input({ target: "draft-07" });
  const convertible = schema as {
    toJSONSchema?: () => Record<string, unknown>;
  };
  if (typeof convertible.toJSONSchema === "function")
    return convertible.toJSONSchema();
  throw new Error(
    `Cannot convert schema to JSON Schema. The schema (vendor: "${standard?.vendor}") does not implement Standard JSON Schema V1. Use a library that supports Standard JSON Schema (e.g. Zod 3.24+, Valibot v1+, ArkType v2+).`,
  );
}

/**
 * Builds one AI SDK tool from a definition, with the schema handed over unchanged.
 *
 * The casts are the vendor's own problem, restated: relating a generic Standard Schema to the AI
 * SDK's `FlexibleSchema` union — conditional types spanning Zod v3 and v4 — makes type instantiation
 * explode (TS2589) under this package's compiler settings. Nothing changes at runtime; the SDK's
 * `asSchema()` validates the schema exactly as it did before.
 */
function buildTool(
  definition: ToolDefinition,
  inputSchema: unknown,
): ToolSet[string] {
  return tool({
    description: definition.description,
    inputSchema: inputSchema as never,
    execute: definition.execute as never,
  }) as ToolSet[string];
}

/**
 * Converts ToolDefinition array to a Vercel AI SDK ToolSet.
 *
 * For Zod schemas, passes them directly to the AI SDK (Zod satisfies FlexibleSchema). For non-Zod
 * schemas, converts to JSON Schema via {@link schemaToJsonSchema} and wraps with the AI SDK's
 * `jsonSchema()` helper.
 */
export function convertToolDefinitionsToVercelAITools(
  tools: ToolDefinition[],
): ToolSet {
  const result: ToolSet = {};
  for (const definition of tools)
    result[definition.name] = isZodSchema(definition.parameters)
      ? buildTool(definition, definition.parameters)
      : buildTool(
          definition,
          jsonSchema(schemaToJsonSchema(definition.parameters)),
        );
  return result;
}

/** Type guard: returns true if this is a factory-mode config. */
function isFactoryConfig(
  config: BuiltInAgentConfiguration,
): config is BuiltInAgentCustomFactoryConfig {
  return "factory" in config;
}

/** One AI SDK stream part, read by kind. Fields a provider does not send are simply absent. */
type StreamPart = { type: string } & Record<string, unknown>;

/** A tool call's progress through the stream, so a start and an end are each sent once. */
type ToolCallState = {
  toolName?: string;
  started: boolean;
  hasArgsDelta: boolean;
  ended: boolean;
};

export class BuiltInAgent extends AbstractAgent {
  private config: BuiltInAgentConfiguration;
  private abortController?: AbortController;
  /**
   * Which vendor this agent's configured model reaches, computed once from the configured model.
   * Read onto the run telemetry by the SSE layer.
   */
  readonly modelHostClass: ModelHostClass;

  constructor(config: BuiltInAgentConfiguration) {
    super();
    this.config = config;
    this.modelHostClass = isFactoryConfig(config)
      ? "unknown"
      : classifyModelSpec(config.model);
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    const inferred: AgentCapabilities = {
      tools: {
        supported: true,
        clientProvided: true,
      },
      transport: { streaming: true },
      humanInTheLoop: { interrupts: true },
    };
    const capabilities = isFactoryConfig(this.config)
      ? undefined
      : this.config.capabilities;
    if (!capabilities) return inferred;
    return { ...inferred, ...capabilities };
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    if (isFactoryConfig(this.config))
      return this.runFactory(input, this.config);
    const config = this.config;
    if (this.abortController)
      throw new Error(
        "Agent is already running. Call abortRun() first or create a new instance.",
      );
    this.abortController = new AbortController();
    const abortController = this.abortController;
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        protocolVersion: PROTOCOL_VERSION,
      } as BaseEvent);
      const model = resolveModel(config.model, config.apiKey);
      let systemPrompt: string | undefined;
      const hasPrompt = !!config.prompt;
      const hasContext = input.context && input.context.length > 0;
      const hasState =
        input.state !== undefined &&
        input.state !== null &&
        !(
          typeof input.state === "object" &&
          Object.keys(input.state).length === 0
        );
      if (hasPrompt || hasContext || hasState) {
        const parts: string[] = [];
        if (hasPrompt) parts.push(config.prompt as string);
        if (hasContext) {
          parts.push("\n## Context from the application\n");
          for (const ctx of input.context ?? [])
            parts.push(`${ctx.description}:\n${ctx.value}\n`);
        }
        if (hasState)
          parts.push(`
## Application State
This is state from the application that you can edit by calling AGUISendStateSnapshot or AGUISendStateDelta.
\`\`\`json
${JSON.stringify(input.state, null, 2)}
\`\`\`
`);
        systemPrompt = parts.join("");
      }
      const messages = convertMessagesToVercelAISDKMessages(input.messages, {
        forwardSystemMessages: config.forwardSystemMessages,
        forwardDeveloperMessages: config.forwardDeveloperMessages,
      });
      if (systemPrompt)
        messages.unshift({ role: "system", content: systemPrompt });
      const resumeEntries = input.resume ?? [];
      if (resumeEntries.length > 0) {
        const toolNameById = new Map<string, string>();
        for (const m of input.messages) {
          if (m.role !== "assistant") continue;
          for (const tc of m.toolCalls ?? [])
            if (tc.id && tc.function?.name)
              toolNameById.set(tc.id, tc.function.name);
        }
        const alreadyAnswered = new Set<string>();
        for (const m of messages) {
          if (m.role !== "tool" || !Array.isArray(m.content)) continue;
          for (const part of m.content)
            if (part && typeof part === "object" && "toolCallId" in part)
              alreadyAnswered.add(part.toolCallId);
        }
        for (const entry of resumeEntries) {
          if (alreadyAnswered.has(entry.interruptId)) continue;
          const value =
            entry.status === "cancelled"
              ? { status: "cancelled" }
              : (entry.payload ?? { status: "resolved" });
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: entry.interruptId,
                toolName: toolNameById.get(entry.interruptId) ?? "",
                output: { type: "json", value },
              },
            ],
          } as unknown as ModelMessage);
        }
      }
      let allTools = convertToolsToVercelAITools(input.tools);
      if (config.tools && config.tools.length > 0) {
        const configTools = convertToolDefinitionsToVercelAITools(config.tools);
        allTools = { ...allTools, ...configTools };
      }
      const streamTextParams = {
        model,
        messages,
        tools: allTools,
        toolChoice: config.toolChoice,
        stopWhen: config.maxSteps ? stepCountIs(config.maxSteps) : undefined,
        maxOutputTokens: config.maxOutputTokens,
        temperature: config.temperature,
        topP: config.topP,
        topK: config.topK,
        presencePenalty: config.presencePenalty,
        frequencyPenalty: config.frequencyPenalty,
        stopSequences: config.stopSequences,
        seed: config.seed,
        providerOptions: config.providerOptions,
        maxRetries: config.maxRetries,
      };
      (async () => {
        let terminalEventEmitted = false;
        let messageId: string = crypto.randomUUID();
        let reasoningMessageId: string = crypto.randomUUID();
        let isInReasoning = false;
        const closeReasoningIfOpen = () => {
          if (!isInReasoning) return;
          isInReasoning = false;
          subscriber.next({
            type: EventType.REASONING_MESSAGE_END,
            messageId: reasoningMessageId,
          } as BaseEvent);
          subscriber.next({
            type: EventType.REASONING_END,
            messageId: reasoningMessageId,
          } as BaseEvent);
        };
        try {
          /* The state tools are always offered: they are how a model edits the application state
           * it was shown. A tool the client already declared with the same name is replaced, and
           * the client's version has no execute, so the vendor's ordering is kept. */
          const toolsWithState: ToolSet = {
            ...streamTextParams.tools,
            AGUISendStateSnapshot: tool({
              description:
                "Replace the entire application state with a new snapshot",
              inputSchema: jsonSchema<{ snapshot: unknown }>({
                type: "object",
                properties: {
                  snapshot: { description: "The complete new state object" },
                },
                required: ["snapshot"],
              }),
              execute: async ({ snapshot }) => ({ success: true, snapshot }),
            }),
            AGUISendStateDelta: tool({
              description:
                "Apply incremental updates to application state using JSON Patch operations",
              inputSchema: jsonSchema<{ delta: unknown }>({
                type: "object",
                properties: {
                  delta: {
                    type: "array",
                    description: "Array of JSON Patch operations",
                    items: {
                      type: "object",
                      properties: {
                        op: {
                          type: "string",
                          enum: ["add", "replace", "remove"],
                          description: "The operation to perform",
                        },
                        path: {
                          type: "string",
                          description: "JSON Pointer path (e.g., '/foo/bar')",
                        },
                        value: {
                          description:
                            "The value to set. Required for 'add' and 'replace' operations, ignored for 'remove'.",
                        },
                      },
                      required: ["op", "path"],
                    },
                  },
                },
                required: ["delta"],
              }),
              execute: async ({ delta }) => ({ success: true, delta }),
            }),
          };
          abortController.signal.throwIfAborted();
          const response = streamText({
            ...streamTextParams,
            tools: toolsWithState,
            abortSignal: abortController.signal,
          });
          const interruptToolNames = new Set(
            (config.tools ?? []).filter((t) => t.interrupt).map((t) => t.name),
          );
          const interruptToolMeta = new Map(
            (config.tools ?? [])
              .filter((t) => t.interrupt)
              .map((t) => [
                t.name,
                {
                  reason: t.interruptReason ?? "tool_call",
                  message: t.interruptMessage,
                },
              ]),
          );
          const pendingInterrupts: Interrupt[] = [];
          const normalizeStateEvent = createStateEventNormalizer(input.state);
          const toolCallStates = new Map<string, ToolCallState>();
          const ensureToolCallState = (toolCallId: string): ToolCallState => {
            let state = toolCallStates.get(toolCallId);
            if (!state) {
              state = { started: false, hasArgsDelta: false, ended: false };
              toolCallStates.set(toolCallId, state);
            }
            return state;
          };
          const warnedUnknownPartTypes = new Set<string>();
          for await (const rawPart of response.fullStream) {
            const part = rawPart as unknown as StreamPart;
            if (part.type !== "reasoning-delta") closeReasoningIfOpen();
            switch (part.type) {
              case "abort": {
                subscriber.next({
                  type: EventType.RUN_FINISHED,
                  threadId: input.threadId,
                  runId: input.runId,
                  ...(input.protocolVersion !== undefined
                    ? { outcome: { type: "cancelled" } }
                    : {}),
                } as BaseEvent);
                terminalEventEmitted = true;
                subscriber.complete();
                break;
              }
              case "reasoning-start": {
                reasoningMessageId = resolveStreamPartMessageId(part.id);
                subscriber.next({
                  type: EventType.REASONING_START,
                  messageId: reasoningMessageId,
                } as BaseEvent);
                subscriber.next({
                  type: EventType.REASONING_MESSAGE_START,
                  messageId: reasoningMessageId,
                  role: "reasoning",
                } as BaseEvent);
                isInReasoning = true;
                break;
              }
              case "reasoning-delta": {
                const delta = typeof part.text === "string" ? part.text : "";
                if (!delta) break;
                subscriber.next({
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: reasoningMessageId,
                  delta,
                } as BaseEvent);
                break;
              }
              case "reasoning-end":
                break;
              case "tool-input-start": {
                const toolCallId = String(part.id);
                const state = ensureToolCallState(toolCallId);
                state.toolName =
                  typeof part.toolName === "string" ? part.toolName : undefined;
                if (!state.started) {
                  state.started = true;
                  subscriber.next({
                    type: EventType.TOOL_CALL_START,
                    parentMessageId: messageId,
                    toolCallId,
                    toolCallName: state.toolName,
                  } as BaseEvent);
                }
                break;
              }
              case "tool-input-delta": {
                const toolCallId = String(part.id);
                const state = ensureToolCallState(toolCallId);
                state.hasArgsDelta = true;
                subscriber.next({
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId,
                  delta: part.delta,
                } as BaseEvent);
                break;
              }
              case "tool-input-end":
                break;
              case "text-start":
                messageId = resolveStreamPartMessageId(part.id);
                break;
              case "text-delta": {
                const textDelta =
                  typeof part.text === "string" ? part.text : "";
                subscriber.next({
                  type: EventType.TEXT_MESSAGE_CHUNK,
                  role: "assistant",
                  messageId,
                  delta: textDelta,
                } as BaseEvent);
                break;
              }
              case "tool-call": {
                const toolCallId = String(part.toolCallId);
                const state = ensureToolCallState(toolCallId);
                state.toolName =
                  typeof part.toolName === "string"
                    ? part.toolName
                    : state.toolName;
                if (!state.started) {
                  state.started = true;
                  subscriber.next({
                    type: EventType.TOOL_CALL_START,
                    parentMessageId: messageId,
                    toolCallId,
                    toolCallName: part.toolName,
                  } as BaseEvent);
                }
                if (!state.hasArgsDelta && part.input !== undefined) {
                  let serializedInput = "";
                  if (typeof part.input === "string")
                    serializedInput = part.input;
                  else
                    try {
                      serializedInput = JSON.stringify(part.input);
                    } catch {
                      serializedInput = String(part.input);
                    }
                  if (serializedInput.length > 0) {
                    subscriber.next({
                      type: EventType.TOOL_CALL_ARGS,
                      toolCallId,
                      delta: serializedInput,
                    } as BaseEvent);
                    state.hasArgsDelta = true;
                  }
                }
                if (!state.ended) {
                  state.ended = true;
                  subscriber.next({
                    type: EventType.TOOL_CALL_END,
                    toolCallId,
                  } as BaseEvent);
                }
                if (state.toolName && interruptToolNames.has(state.toolName)) {
                  const meta = interruptToolMeta.get(state.toolName);
                  pendingInterrupts.push({
                    id: toolCallId,
                    toolCallId,
                    reason: meta?.reason ?? "tool_call",
                    ...(meta?.message ? { message: meta.message } : {}),
                  } as Interrupt);
                }
                break;
              }
              case "tool-result": {
                const toolCallId = String(part.toolCallId);
                const toolName =
                  (typeof part.toolName === "string" && part.toolName) ||
                  toolCallStates.get(toolCallId)?.toolName ||
                  "";
                if (toolName && interruptToolNames.has(toolName)) {
                  toolCallStates.delete(toolCallId);
                  break;
                }
                const toolResult =
                  "output" in part
                    ? part.output
                    : "result" in part
                      ? part.result
                      : null;
                toolCallStates.delete(toolCallId);
                if (
                  toolName === "AGUISendStateSnapshot" &&
                  toolResult &&
                  typeof toolResult === "object"
                ) {
                  const snapshot = (toolResult as { snapshot?: unknown })
                    .snapshot;
                  if (snapshot !== undefined)
                    for (const event of normalizeStateEvent({
                      type: EventType.STATE_SNAPSHOT,
                      snapshot,
                    } as BaseEvent))
                      subscriber.next(event);
                } else if (
                  toolName === "AGUISendStateDelta" &&
                  toolResult &&
                  typeof toolResult === "object"
                ) {
                  const delta = (toolResult as { delta?: unknown }).delta;
                  if (delta !== undefined)
                    for (const event of normalizeStateEvent({
                      type: EventType.STATE_DELTA,
                      delta,
                    } as BaseEvent))
                      subscriber.next(event);
                }
                let serializedResult: string;
                try {
                  serializedResult = JSON.stringify(toolResult);
                } catch {
                  serializedResult = `[Unserializable tool result from ${toolName || toolCallId}]`;
                }
                subscriber.next({
                  type: EventType.TOOL_CALL_RESULT,
                  role: "tool",
                  messageId: crypto.randomUUID(),
                  toolCallId,
                  content: serializedResult,
                } as BaseEvent);
                break;
              }
              case "tool-error": {
                const toolCallId = String(part.toolCallId);
                const toolName =
                  (typeof part.toolName === "string" && part.toolName) ||
                  toolCallStates.get(toolCallId)?.toolName ||
                  "";
                if (toolName && interruptToolNames.has(toolName)) {
                  toolCallStates.delete(toolCallId);
                  break;
                }
                toolCallStates.delete(toolCallId);
                subscriber.next({
                  type: EventType.TOOL_CALL_RESULT,
                  role: "tool",
                  messageId: crypto.randomUUID(),
                  toolCallId,
                  content: `Error: ${formatToolError(part.error)}`,
                } as BaseEvent);
                break;
              }
              case "finish": {
                const finishedEvent = {
                  type: EventType.RUN_FINISHED,
                  threadId: input.threadId,
                  runId: input.runId,
                  ...getAISDKRunFinishedDetails(
                    part as { finishReason?: unknown; totalUsage?: unknown },
                    {
                      provider: isRecord(model)
                        ? getNonEmptyString(model.provider)
                        : undefined,
                      model: isRecord(model)
                        ? getNonEmptyString(model.modelId)
                        : undefined,
                    },
                  ),
                  ...(pendingInterrupts.length > 0
                    ? {
                        outcome: {
                          type: "interrupt",
                          interrupts: pendingInterrupts,
                        },
                      }
                    : {}),
                } as BaseEvent;
                subscriber.next(finishedEvent);
                terminalEventEmitted = true;
                subscriber.complete();
                break;
              }
              case "error": {
                if (abortController.signal.aborted) break;
                const err =
                  part.error ??
                  ("message" in part ? part.message : undefined) ??
                  ("cause" in part ? part.cause : undefined);
                subscriber.next({
                  type: EventType.RUN_ERROR,
                  message:
                    err instanceof Error
                      ? err.message
                      : typeof err === "string"
                        ? err
                        : `AI SDK stream error: ${JSON.stringify(part)}`,
                  threadId: input.threadId,
                  runId: input.runId,
                } as BaseEvent);
                terminalEventEmitted = true;
                if (err instanceof Error) subscriber.error(err);
                else
                  subscriber.error(
                    new Error(
                      typeof err === "string" ? err : "AI SDK stream error",
                    ),
                  );
                break;
              }
              case "start":
              case "start-step":
              case "finish-step":
              case "text-end":
              case "source":
              case "file":
              case "tool-output-denied":
              case "tool-approval-request":
              case "raw":
                break;
              default: {
                const unknownType = String(part.type);
                if (!warnedUnknownPartTypes.has(unknownType)) {
                  warnedUnknownPartTypes.add(unknownType);
                  console.warn(
                    `[BuiltInAgent] Ignoring unhandled AI SDK stream part: ${unknownType}`,
                  );
                }
                break;
              }
            }
          }
          if (!terminalEventEmitted) {
            closeReasoningIfOpen();
            if (!abortController.signal.aborted) {
              subscriber.next({
                type: EventType.RUN_FINISHED,
                threadId: input.threadId,
                runId: input.runId,
                ...(pendingInterrupts.length > 0
                  ? {
                      outcome: {
                        type: "interrupt",
                        interrupts: pendingInterrupts,
                      },
                    }
                  : {}),
              } as BaseEvent);
            }
            terminalEventEmitted = true;
            subscriber.complete();
          }
        } catch (error) {
          closeReasoningIfOpen();
          if (abortController.signal.aborted) subscriber.complete();
          else {
            subscriber.next({
              type: EventType.RUN_ERROR,
              message: error instanceof Error ? error.message : String(error),
              threadId: input.threadId,
              runId: input.runId,
            } as BaseEvent);
            terminalEventEmitted = true;
            subscriber.error(error);
          }
        } finally {
          if (this.abortController === abortController)
            this.abortController = undefined;
        }
      })();
      return () => {
        abortController.abort();
        if (this.abortController === abortController)
          this.abortController = undefined;
      };
    });
  }

  /**
   * Factory mode: the caller makes the model call, this class owns the run's lifecycle.
   *
   * A resumed tool call is answered twice over — the resume message is appended to the run's
   * conversation AND its result event is sent before the factory starts — because a factory that
   * replays the whole conversation must see the answer in the messages, and one that streams
   * events must see the answer as an event. A factory that emits the result again is suppressed by
   * the `resumedResults` check, and a second, different answer for the same call is a
   * contradiction rather than a duplicate, so it ends the run.
   */
  private runFactory(
    input: RunAgentInput,
    config: BuiltInAgentCustomFactoryConfig,
  ): Observable<BaseEvent> {
    if (this.abortController)
      throw new Error(
        "Agent is already running. Call abortRun() first or create a new instance.",
      );
    this.abortController = new AbortController();
    const controller = this.abortController;
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        protocolVersion: PROTOCOL_VERSION,
      } as BaseEvent);
      const ctx: AgentFactoryContext = {
        input,
        abortController: controller,
        abortSignal: controller.signal,
        interrupt: async (interrupts) => {
          const resume = input.resume ?? [];
          const ids = new Set(interrupts.map((i) => i.id));
          const matching = resume.filter((r) => ids.has(r.interruptId));
          if (interrupts.length > 0 && matching.length === interrupts.length)
            return matching;
          throw new InterruptSignal(interrupts);
        },
      };
      (async () => {
        const runFinishedDetails: Record<string, unknown> = {};
        try {
          const toolCallIds = new Set(
            input.messages.flatMap((message) =>
              message.role === "assistant"
                ? (message.toolCalls ?? []).map((call) => call.id)
                : [],
            ),
          );
          const answeredToolMessages = input.messages.filter(
            (message): message is Message & { toolCallId: string } =>
              message.role === "tool",
          );
          const answeredToolCallIds = new Set(
            answeredToolMessages.map((message) => message.toolCallId),
          );
          const resumeToolMessages: (Message & { toolCallId: string })[] = [];
          const decisionsByCall = new Map<string, string>();
          for (const entry of input.resume ?? []) {
            if (!toolCallIds.has(entry.interruptId)) continue;
            const content = JSON.stringify(
              entry.status === "cancelled"
                ? { status: "cancelled" }
                : (entry.payload ?? { status: "resolved" }),
            );
            if (decisionsByCall.has(entry.interruptId)) {
              if (decisionsByCall.get(entry.interruptId) !== content)
                throw new Error(
                  `Conflicting decisions for resumed tool call ${entry.interruptId}`,
                );
              continue;
            }
            decisionsByCall.set(entry.interruptId, content);
            if (answeredToolCallIds.has(entry.interruptId)) continue;
            resumeToolMessages.push({
              id: crypto.randomUUID(),
              role: "tool",
              toolCallId: entry.interruptId,
              content,
            } as Message & { toolCallId: string });
          }
          const resumedIds = new Set(
            (input.resume ?? []).map((entry) => entry.interruptId),
          );
          const resumedResults = new Map(
            [...answeredToolMessages, ...resumeToolMessages]
              .filter((message) => resumedIds.has(message.toolCallId))
              .map((message) => [message.toolCallId, message.content]),
          );
          for (const message of resumeToolMessages)
            subscriber.next({
              type: EventType.TOOL_CALL_RESULT,
              messageId: message.id,
              toolCallId: message.toolCallId,
              role: "tool",
              content: message.content,
            } as BaseEvent);
          /* A custom factory owns the conversation it replays, so a resume is not appended for it:
           * only the events were sent. */
          const factoryInput: RunAgentInput =
            resumeToolMessages.length > 0
              ? {
                  ...input,
                  messages: [...input.messages, ...resumeToolMessages],
                }
              : input;
          controller.signal.throwIfAborted();
          const events = await config.factory({ ...ctx, input: factoryInput });
          let customRunFinishedEvent: BaseEvent | undefined;
          for await (const event of events) {
            if (
              event.type === EventType.TOOL_CALL_RESULT &&
              "toolCallId" in event &&
              typeof event.toolCallId === "string" &&
              "content" in event &&
              resumedResults.has(event.toolCallId)
            ) {
              if (resumedResults.get(event.toolCallId) !== event.content)
                throw new Error(
                  `Conflicting result for resumed tool call ${event.toolCallId}`,
                );
              continue;
            }
            if (event.type === EventType.RUN_FINISHED) {
              customRunFinishedEvent = event;
              collectRunFinishedDetails(event, runFinishedDetails);
              continue;
            }
            subscriber.next(event);
          }
          if (!controller.signal.aborted) {
            subscriber.next({
              ...customRunFinishedEvent,
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
              ...runFinishedDetails,
            } as BaseEvent);
          }
          subscriber.complete();
        } catch (error) {
          if (error instanceof InterruptSignal) {
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
              ...runFinishedDetails,
              outcome: { type: "interrupt", interrupts: error.interrupts },
            } as BaseEvent);
            subscriber.complete();
          } else if (controller.signal.aborted) subscriber.complete();
          else {
            subscriber.next({
              type: EventType.RUN_ERROR,
              message: error instanceof Error ? error.message : String(error),
              threadId: input.threadId,
              runId: input.runId,
            } as BaseEvent);
            subscriber.error(error);
          }
        } finally {
          if (this.abortController === controller)
            this.abortController = undefined;
        }
      })();
      return () => {
        controller.abort();
        if (this.abortController === controller)
          this.abortController = undefined;
      };
    });
  }

  /**
   * Carried by hand because `AbstractAgent.clone` builds a bare object on this class's prototype
   * and copies a fixed list of base fields: the runtime clones an agent before every run, so
   * without this the first message anyone sends would reach an agent with no configuration at all.
   * The middleware list is copied too, and reached through a cast because `AbstractAgent` declares
   * it private.
   */
  clone(): BuiltInAgent {
    const cloned = new BuiltInAgent(this.config);
    type WithMiddlewares = { middlewares: unknown[] };
    (cloned as unknown as WithMiddlewares).middlewares = [
      ...(this as unknown as WithMiddlewares).middlewares,
    ];
    return cloned;
  }

  abortRun(): void {
    this.abortController?.abort();
  }
}

/** Keeps a factory's own RUN_FINISHED metadata and usage, the last finish reason winning. */
function collectRunFinishedDetails(
  event: BaseEvent,
  details: Record<string, unknown>,
): void {
  const finished = event as { metadata?: unknown; usage?: unknown };
  const previousFinishReason = (details.metadata as { finishReason?: unknown })
    ?.finishReason;
  if (isRecord(finished.metadata)) details.metadata = { ...finished.metadata };
  else delete details.metadata;
  if (
    !isRecord(details.metadata) ||
    typeof details.metadata.finishReason !== "string"
  )
    if (typeof previousFinishReason === "string")
      details.metadata = {
        ...(isRecord(details.metadata) ? details.metadata : {}),
        finishReason: previousFinishReason,
      };
  if (Array.isArray(finished.usage)) details.usage = finished.usage;
}
