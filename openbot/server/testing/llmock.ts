/**
 * A deterministic, in-repo stand-in for the model APIs this deployment talks to.
 *
 * This is the repo's own model mock. It speaks the three wire protocols the product
 * actually uses, on one port, and answers from a list of fixtures:
 *
 *   POST /v1/chat/completions   OpenAI chat completions (streaming and not)
 *   POST /v1/responses          OpenAI Responses (streaming and not)
 *   POST /v1/messages           Anthropic Messages (streaming and not)
 *
 * A test points `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` at `await mock.start()` and scripts the
 * answers with `on` / `onMessage`. The journal behind `getRequests()` is what a test reads to assert
 * what the product actually sent.
 *
 * The protocol shapes were captured from the mock this one replaced, so a
 * client that parsed aimock's answers parses these.
 */

/** One tool call a fixture asks the model to emit. `arguments` may be an object or a JSON string. */
export type MockToolCall = {
	id?: string;
	name: string;
	arguments?: string | Record<string, unknown> | unknown[];
};

/** What a fixture answers with. `content` and `toolCalls` may both be set; text comes first. */
export type MockResponse = {
	type?: "text";
	content?: string | null;
	text?: string;
	toolCalls?: MockToolCall[];
};

/** A raw request body, as the journal records it. */
export type MockRequestBody = Record<string, unknown>;

/** The journal entry `getRequests()` returns, one per HTTP request served. */
export type MockRequestEntry = {
	id: string;
	timestamp: number;
	method: string;
	path: string;
	headers: Record<string, string>;
	body: MockRequestBody | null;
};

/** How a fixture decides whether it answers a request. Every field present must match. */
export type MockMatch = {
	/** Substring (or regexp) of the last user message's text. */
	userMessage?: string | RegExp;
	/** Substring (or regexp) of every system message's text joined; an array means all must appear. */
	systemMessage?: string | string[] | RegExp;
	/** The last message must be a tool result carrying this call id. */
	toolCallId?: string;
	/** The request must (or must not) carry a tool result in its final turn. */
	hasToolResult?: boolean;
	/** Anything else about the request the fixture needs. */
	predicate?: (request: MockRequestBody) => boolean;
};

type MockResponseFactory = (
	request: MockRequestBody,
) => MockResponse | Promise<MockResponse>;

type Fixture = {
	match: MockMatch;
	response: MockResponse | MockResponseFactory;
};

type NormalizedMessage = {
	role: string;
	text: string;
	toolCallId?: string;
	isToolResult: boolean;
};

const randomId = (prefix: string): string =>
	`${prefix}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * The text of a message whose content may be a string or an array of content parts.
 *
 * Every protocol puts text somewhere different inside a part, so this reads all three spellings
 * (`text`, `input_text`, `output_text`) rather than pretending one shape.
 */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n");
}

/** Every content part of a message, as records. */
function contentParts(content: unknown): Record<string, unknown>[] {
	if (!Array.isArray(content)) return [];
	const parts: Record<string, unknown>[] = [];
	for (const part of content) {
		if (part && typeof part === "object")
			parts.push(part as Record<string, unknown>);
	}
	return parts;
}

/** The messages a request carries, whichever protocol it speaks. */
function messagesOf(body: MockRequestBody): NormalizedMessage[] {
	const messages: NormalizedMessage[] = [];
	const push = (role: unknown, content: unknown, extra: Partial<NormalizedMessage> = {}) => {
		messages.push({
			role: typeof role === "string" ? role : "user",
			text: contentText(content),
			isToolResult: false,
			...extra,
		});
	};

	const input = body.messages ?? body.input;
	if (typeof input === "string") {
		push("user", input);
	} else if (Array.isArray(input)) {
		for (const message of input) {
			if (!message || typeof message !== "object") continue;
			const record = message as Record<string, unknown>;
			if (typeof record.type === "string" && record.type.endsWith("_output")) {
				// A Responses-API tool result arrives as its own input item, not as a message.
				messages.push({
					role: "tool",
					text: contentText(record.output ?? record.content),
					isToolResult: true,
					...(typeof record.call_id === "string"
						? { toolCallId: record.call_id }
						: {}),
				});
				continue;
			}
			const parts = contentParts(record.content);
			const carriesToolResult = parts.some(
				(part) => part.type === "tool_result",
			);
			push(record.role, record.content, {
				...(typeof record.tool_call_id === "string"
					? { toolCallId: record.tool_call_id }
					: {}),
				...(record.role === "tool" || carriesToolResult
					? { isToolResult: true }
					: {}),
			});
		}
	}

	const system = body.system;
	if (typeof system === "string") messages.unshift({ role: "system", text: system, isToolResult: false });
	else if (Array.isArray(system))
		messages.unshift({ role: "system", text: contentText(system), isToolResult: false });
	return messages;
}

function lastUserText(messages: NormalizedMessage[]): string | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user") return message.text;
	}
	return null;
}

function systemText(messages: NormalizedMessage[]): string {
	return messages
		.filter((message) => message.role === "system")
		.map((message) => message.text)
		.join("\n");
}

function matchesText(expectation: string | RegExp, text: string): boolean {
	return typeof expectation === "string"
		? text.includes(expectation)
		: expectation.test(text);
}

function matches(fixture: Fixture, body: MockRequestBody): boolean {
	const { match } = fixture;
	if (match.predicate && !match.predicate(body)) return false;
	const messages = messagesOf(body);

	if (match.userMessage !== undefined) {
		const text = lastUserText(messages);
		if (text === null) return false;
		if (!matchesText(match.userMessage, text)) return false;
	}
	if (match.systemMessage !== undefined) {
		const text = systemText(messages);
		if (Array.isArray(match.systemMessage)) {
			for (const needle of match.systemMessage)
				if (!text.includes(needle)) return false;
		} else if (!matchesText(match.systemMessage, text)) return false;
	}
	const last = messages[messages.length - 1];
	if (match.toolCallId !== undefined) {
		if (!last || !last.isToolResult || last.toolCallId !== match.toolCallId)
			return false;
	}
	if (match.hasToolResult !== undefined) {
		const has = messages.some((message) => message.isToolResult);
		if (has !== match.hasToolResult) return false;
	}
	return true;
}

/** The response body of a fixture: text, tool calls, or both, with text first. */
function resolveResponse(response: MockResponse): {
	text: string;
	toolCalls: { id: string; name: string; arguments: string }[];
} {
	const text = response.content ?? response.text ?? "";
	const toolCalls = (response.toolCalls ?? []).map((call, index) => ({
		id: call.id ?? `call_${index}`,
		name: call.name,
		arguments:
			typeof call.arguments === "string"
				? call.arguments
				: JSON.stringify(call.arguments ?? {}),
	}));
	return { text, toolCalls };
}

const sseHeaders = {
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
	connection: "keep-alive",
};

function sse(events: string[]): Response {
	const body = events.join("");
	return new Response(body, { headers: sseHeaders });
}

function chatCompletion(
	body: MockRequestBody,
	resolved: { text: string; toolCalls: { id: string; name: string; arguments: string }[] },
): Response {
	const model = typeof body.model === "string" ? body.model : "mock-model";
	const id = randomId("chatcmpl");
	const created = Math.floor(Date.now() / 1000);
	const finishReason = resolved.toolCalls.length > 0 ? "tool_calls" : "stop";
	const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

	if (body.stream !== true) {
		return Response.json({
			id,
			object: "chat.completion",
			created,
			model,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: resolved.toolCalls.length > 0 && !resolved.text ? null : resolved.text,
						refusal: null,
						...(resolved.toolCalls.length > 0
							? {
									tool_calls: resolved.toolCalls.map((call) => ({
										id: call.id,
										type: "function",
										function: { name: call.name, arguments: call.arguments },
									})),
								}
							: {}),
					},
					logprobs: null,
					finish_reason: finishReason,
				},
			],
			usage,
		});
	}

	const chunk = (delta: Record<string, unknown>, finish: string | null) =>
		`data: ${JSON.stringify({
			id,
			object: "chat.completion.chunk",
			created,
			model,
			choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
		})}\n\n`;

	const events: string[] = [chunk({ role: "assistant", content: "" }, null)];
	if (resolved.text) events.push(chunk({ content: resolved.text }, null));
	resolved.toolCalls.forEach((call, index) => {
		events.push(
			chunk(
				{
					tool_calls: [
						{
							index,
							id: call.id,
							type: "function",
							function: { name: call.name, arguments: "" },
						},
					],
				},
				null,
			),
		);
		events.push(
			chunk(
				{
					tool_calls: [{ index, function: { arguments: call.arguments } }],
				},
				null,
			),
		);
	});
	events.push(chunk({}, finishReason));
	events.push("data: [DONE]\n\n");
	return sse(events);
}

function responsesResponse(
	body: MockRequestBody,
	resolved: { text: string; toolCalls: { id: string; name: string; arguments: string }[] },
): Response {
	const model = typeof body.model === "string" ? body.model : "mock-model";
	const id = randomId("resp");
	const createdAt = Math.floor(Date.now() / 1000);
	const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

	type OutputItem = Record<string, unknown>;
	const items: OutputItem[] = [];
	const textItemId = randomId("msg");
	if (resolved.text || resolved.toolCalls.length === 0) {
		items.push({
			type: "message",
			id: textItemId,
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: resolved.text, annotations: [] }],
		});
	}
	for (const call of resolved.toolCalls) {
		items.push({
			type: "function_call",
			id: randomId("fc"),
			call_id: call.id,
			name: call.name,
			arguments: call.arguments,
			status: "completed",
		});
	}

	if (body.stream !== true) {
		return Response.json({
			id,
			object: "response",
			created_at: createdAt,
			model,
			status: "completed",
			output: items,
			usage,
		});
	}

	const responseEnvelope = {
		id,
		object: "response",
		created_at: createdAt,
		model,
		status: "in_progress",
		output: [] as OutputItem[],
	};
	const events: string[] = [];
	const event = (type: string, payload: Record<string, unknown>) => {
		events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
	};

	event("response.created", { response: responseEnvelope });
	event("response.in_progress", { response: responseEnvelope });

	let outputIndex = 0;
	if (resolved.text || resolved.toolCalls.length === 0) {
		const item = {
			type: "message",
			id: textItemId,
			status: "in_progress",
			role: "assistant",
			content: [] as unknown[],
		};
		event("response.output_item.added", { output_index: outputIndex, item });
		event("response.content_part.added", {
			item_id: textItemId,
			output_index: outputIndex,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		});
		event("response.output_text.delta", {
			item_id: textItemId,
			output_index: outputIndex,
			content_index: 0,
			delta: resolved.text,
		});
		event("response.output_text.done", {
			item_id: textItemId,
			output_index: outputIndex,
			content_index: 0,
			text: resolved.text,
		});
		event("response.content_part.done", {
			item_id: textItemId,
			output_index: outputIndex,
			content_index: 0,
			part: { type: "output_text", text: resolved.text, annotations: [] },
		});
		event("response.output_item.done", {
			output_index: outputIndex,
			item: {
				type: "message",
				id: textItemId,
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: resolved.text, annotations: [] }],
			},
		});
		outputIndex += 1;
	}
	for (const call of resolved.toolCalls) {
		const itemId = randomId("fc");
		event("response.output_item.added", {
			output_index: outputIndex,
			item: {
				type: "function_call",
				id: itemId,
				call_id: call.id,
				name: call.name,
				arguments: "",
				status: "in_progress",
			},
		});
		event("response.function_call_arguments.delta", {
			item_id: itemId,
			output_index: outputIndex,
			delta: call.arguments,
		});
		event("response.function_call_arguments.done", {
			item_id: itemId,
			output_index: outputIndex,
			arguments: call.arguments,
		});
		event("response.output_item.done", {
			output_index: outputIndex,
			item: {
				type: "function_call",
				id: itemId,
				call_id: call.id,
				name: call.name,
				arguments: call.arguments,
				status: "completed",
			},
		});
		outputIndex += 1;
	}
	event("response.completed", {
		response: { ...responseEnvelope, status: "completed", output: items, usage },
	});
	return sse(events);
}

function anthropicResponse(
	body: MockRequestBody,
	resolved: { text: string; toolCalls: { id: string; name: string; arguments: string }[] },
): Response {
	const model = typeof body.model === "string" ? body.model : "mock-model";
	const id = randomId("msg");
	const stopReason = resolved.toolCalls.length > 0 ? "tool_use" : "end_turn";
	const usage = { input_tokens: 0, output_tokens: 0 };
	const blocks: Record<string, unknown>[] = [];
	if (resolved.text || resolved.toolCalls.length === 0)
		blocks.push({ type: "text", text: resolved.text });
	for (const call of resolved.toolCalls)
		blocks.push({
			type: "tool_use",
			id: call.id,
			name: call.name,
			input: JSON.parse(call.arguments || "{}") as unknown,
		});

	if (body.stream !== true) {
		return Response.json({
			id,
			type: "message",
			role: "assistant",
			content: blocks,
			model,
			stop_reason: stopReason,
			stop_sequence: null,
			usage,
		});
	}

	const events: string[] = [];
	const event = (type: string, payload: Record<string, unknown>) => {
		events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
	};
	event("message_start", {
		message: {
			id,
			type: "message",
			role: "assistant",
			content: [],
			model,
			stop_reason: null,
			stop_sequence: null,
			usage,
		},
	});
	let index = 0;
	if (resolved.text || resolved.toolCalls.length === 0) {
		event("content_block_start", {
			index,
			content_block: { type: "text", text: "" },
		});
		event("content_block_delta", {
			index,
			delta: { type: "text_delta", text: resolved.text },
		});
		event("content_block_stop", { index });
		index += 1;
	}
	for (const call of resolved.toolCalls) {
		event("content_block_start", {
			index,
			content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
		});
		event("content_block_delta", {
			index,
			delta: { type: "input_json_delta", partial_json: call.arguments },
		});
		event("content_block_stop", { index });
		index += 1;
	}
	event("message_delta", {
		delta: { stop_reason: stopReason, stop_sequence: null },
		usage: { output_tokens: 0 },
	});
	event("message_stop", {});
	return sse(events);
}

/** The protocol a request path names. */
function protocolOf(pathname: string): "chat" | "responses" | "anthropic" | null {
	if (pathname.endsWith("/chat/completions")) return "chat";
	if (pathname.endsWith("/responses")) return "responses";
	if (pathname.endsWith("/messages")) return "anthropic";
	return null;
}

/** The text of an Anthropic content block list, or of a plain string. */
function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.join("");
}

function recordParts(content: unknown): Record<string, unknown>[] {
	return Array.isArray(content)
		? content.filter(
				(part): part is Record<string, unknown> =>
					!!part && typeof part === "object",
			)
		: [];
}

/**
 * An Anthropic conversation, in the chat shape.
 *
 * The journal and the fixtures both read `messages` the way the chat protocol spells it, because
 * that is the only shape with one spelling for a tool result. A `tool_result` block becomes a
 * `tool` message, a `tool_use` block becomes `tool_calls`, and the system prompt becomes a leading
 * `system` message — which is exactly what a consumer asserting on `body.messages` expects.
 */
function anthropicMessages(body: MockRequestBody): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];
	if (body.system !== undefined) {
		const system = blockText(body.system);
		if (system) messages.push({ role: "system", content: system });
	}
	const turns = Array.isArray(body.messages) ? body.messages : [];
	for (const turn of turns) {
		if (!turn || typeof turn !== "object") continue;
		const record = turn as Record<string, unknown>;
		const parts = recordParts(record.content);
		if (record.role === "user") {
			const results = parts.filter((part) => part.type === "tool_result");
			const texts = parts.filter((part) => part.type === "text");
			if (results.length > 0) {
				if (texts.length > 0)
					messages.push({
						role: "user",
						content: texts
							.map((part) =>
								typeof part.text === "string" ? part.text : "",
							)
							.join(""),
					});
				for (const result of results)
					messages.push({
						role: "tool",
						content: blockText(result.content),
						tool_call_id: result.tool_use_id,
					});
				continue;
			}
			messages.push({ role: "user", content: blockText(record.content) });
			continue;
		}
		if (record.role === "assistant") {
			const calls = parts.filter((part) => part.type === "tool_use");
			const text = blockText(record.content);
			if (calls.length > 0)
				messages.push({
					role: "assistant",
					content: text || null,
					tool_calls: calls.map((call) => ({
						id: call.id,
						type: "function",
						function: {
							name: typeof call.name === "string" ? call.name : "",
							arguments:
								typeof call.input === "string"
									? call.input
									: JSON.stringify(call.input ?? {}),
						},
					})),
				});
			else messages.push({ role: "assistant", content: text || null });
			continue;
		}
		messages.push({ role: "assistant", content: null });
	}
	return messages;
}

/** The text of a Responses-API content list (`input_text` / `output_text` parts). */
function responsesText(content: unknown): string {
	if (typeof content === "string") return content;
	return recordParts(content)
		.filter((part) => part.type === "input_text" || part.type === "output_text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** A Responses-API conversation, in the chat shape. Same reason as `anthropicMessages`. */
function responsesMessages(body: MockRequestBody): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];
	if (typeof body.instructions === "string" && body.instructions)
		messages.push({ role: "system", content: body.instructions });
	const input = body.input;
	if (typeof input === "string") {
		messages.push({ role: "user", content: input });
		return messages;
	}
	for (const item of Array.isArray(input) ? input : []) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (
			record.role === "system" ||
			record.role === "developer" ||
			record.role === "user" ||
			record.role === "assistant"
		) {
			messages.push({
				role: record.role === "developer" ? "system" : record.role,
				content: responsesText(record.content),
			});
			continue;
		}
		if (record.type === "function_call")
			messages.push({
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: record.call_id ?? randomId("call"),
						type: "function",
						function: {
							name: typeof record.name === "string" ? record.name : "",
							arguments:
								typeof record.arguments === "string"
									? record.arguments
									: JSON.stringify(record.arguments ?? {}),
						},
					},
				],
			});
		else if (record.type === "function_call_output")
			messages.push({
				role: "tool",
				content: record.output ?? "",
				tool_call_id: record.call_id,
			});
		else if (record.type === "item_reference")
			messages.push({ role: "assistant", content: "" });
	}
	return messages;
}

/** Responses-API tools, in the chat shape a consumer reads `body.tools[].function` from. */
function responsesTools(tools: unknown): unknown {
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	return tools
		.filter(
			(tool): tool is Record<string, unknown> =>
				!!tool && typeof tool === "object" && tool.type === "function",
		)
		.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
}

/**
 * Every protocol's request body, in the one shape a test can read.
 *
 * Consumers assert on `body.messages[].role` and `body.tools[].function.name`, and neither is the
 * shape the Anthropic or Responses wire protocol carries. Normalise once, here, so the journal and
 * the fixtures agree with the chat protocol rather than each test re-deriving three spellings.
 */
function normalizeRequestBody(
	protocol: "chat" | "responses" | "anthropic",
	body: MockRequestBody,
): MockRequestBody {
	if (protocol === "anthropic") {
		const tools = Array.isArray(body.tools)
			? body.tools.map((tool) => {
					const record = (tool ?? {}) as Record<string, unknown>;
					return {
						type: "function",
						function: {
							name: record.name,
							description: record.description,
							parameters: record.input_schema,
						},
					};
				})
			: undefined;
		return {
			model: body.model,
			messages: anthropicMessages(body),
			stream: body.stream,
			temperature: body.temperature,
			max_tokens: body.max_tokens,
			...(tools ? { tools } : {}),
		};
	}
	if (protocol === "responses")
		return {
			model: body.model,
			messages: responsesMessages(body),
			stream: body.stream,
			temperature: body.temperature,
			max_tokens: body.max_output_tokens,
			tools: responsesTools(body.tools),
			tool_choice: body.tool_choice,
			response_format: body.response_format,
		};
	return body;
}

/**
 * A scriptable model API on a loopback port.
 *
 * Start it, point the deployment's base URL at it, and register what each request should answer —
 * fixtures are consulted in the order they were registered, and the first match answers.
 */
export class LLMock {
	#fixtures: Fixture[] = [];
	#requests: MockRequestEntry[] = [];
	#server: Bun.Server<undefined> | undefined;

	constructor(options: { port?: number; hostname?: string } = {}) {
		this.#options = options;
	}

	#options: { port?: number; hostname?: string };

	/** Register a fixture against a full match object. */
	on(
		match: MockMatch,
		response: MockResponse | MockResponseFactory,
	): this {
		this.#fixtures.push({ match, response });
		return this;
	}

	/** Register a fixture that answers when the last user message matches `pattern`. */
	onMessage(
		pattern: string | RegExp,
		response: MockResponse | MockResponseFactory,
	): this {
		return this.on({ userMessage: pattern }, response);
	}

	/** Forget every fixture, leaving the journal alone. */
	clearFixtures(): this {
		this.#fixtures = [];
		return this;
	}

	/** Forget every journaled request, leaving the fixtures alone. */
	clearRequests(): this {
		this.#requests = [];
		return this;
	}

	/** Every request served so far, oldest first. */
	getRequests(): MockRequestEntry[] {
		return this.#requests;
	}

	/** Start listening and answer with the base URL to configure the deployment with. */
	start(): Promise<string> {
		if (this.#server) return Promise.resolve(this.#server.url.origin);
		this.#server = Bun.serve({
			port: this.#options.port ?? 0,
			hostname: this.#options.hostname ?? "127.0.0.1",
			fetch: (request) => this.#handle(request),
		});
		return Promise.resolve(this.#server.url.origin);
	}

	/** Stop listening. Safe to call when it never started. */
	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (server) await server.stop(true);
	}

	get url(): string {
		return this.#server?.url.origin ?? "";
	}

	get baseUrl(): string {
		return this.url;
	}

	get port(): number {
		return this.#server?.port ?? 0;
	}

	async #handle(request: Request): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		const protocol = protocolOf(pathname);
		if (protocol === null)
			return Response.json({ error: `No mock for ${pathname}` }, { status: 404 });

		let body: MockRequestBody = {};
		try {
			const parsed = (await request.json()) as unknown;
			if (parsed && typeof parsed === "object")
				body = parsed as MockRequestBody;
		} catch {
			body = {};
		}

		const normalized = normalizeRequestBody(protocol, body);
		const entry: MockRequestEntry = {
			id: randomId("req"),
			timestamp: Date.now(),
			method: request.method,
			path: pathname,
			headers: Object.fromEntries(request.headers.entries()),
			body: normalized,
		};
		this.#requests.push(entry);

		const fixture = this.#fixtures.find((candidate) =>
			matches(candidate, normalized),
		);
		if (!fixture)
			return Response.json(
				{ error: { message: "No fixture matched the request." } },
				{ status: 404 },
			);

		const answer =
			typeof fixture.response === "function"
				? await fixture.response(normalized)
				: fixture.response;
		const resolved = resolveResponse(answer);

		if (protocol === "chat") return chatCompletion(body, resolved);
		if (protocol === "responses") return responsesResponse(body, resolved);
		return anthropicResponse(body, resolved);
	}
}
