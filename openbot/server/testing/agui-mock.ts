/**
 * A deterministic AG-UI agent, in the repo.
 *
 * This is the repo's own AG-UI mock. It answers a run with the events a fixture names,
 * over the AG-UI wire format (`data: {json}\n\n`), which is what an agent registered against this
 * deployment has to speak. The connection test exists to find out whether somebody else's agent
 * really answers, so what it is pointed at has to be a real endpoint rather than a stubbed fetch.
 *
 * Event ids are generated per response, as aimock did: the AG-UI client is entitled to see a
 * RUN_STARTED carrying the run it asked for, and a fixed id would be a lie the second time.
 */

export type AGUIEvent = { type: string } & Record<string, unknown>;

type Fixture = {
	/** Whether this fixture answers the run. */
	accepts: (input: AGUIRunInput) => boolean;
	events: AGUIEvent[];
	delayMs: number;
};

/** The shape of a run request, as far as a fixture needs to see it. */
export type AGUIRunInput = {
	threadId?: string;
	runId?: string;
	messages?: { id?: string; role?: string; content?: unknown }[];
	tools?: { name?: string }[];
	forwardedProps?: Record<string, unknown>;
};

const randomId = (prefix: string): string =>
	`${prefix}-${Math.random().toString(36).slice(2, 12)}`;

/** The text of the last user message, for pattern matching. */
function lastUserText(input: AGUIRunInput): string {
	const messages = input.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content))
			return content
				.map((part) =>
					part && typeof part === "object" && "text" in part
						? String((part as { text?: unknown }).text ?? "")
						: "",
				)
				.join("\n");
	}
	return "";
}

function matchesPattern(pattern: string | RegExp, text: string): boolean {
	return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
}

/**
 * A complete assistant text turn: the events every client expects from a working agent.
 *
 * Built rather than hand-written because the protocol requires the envelope as well as the message:
 * a run that starts, says something, and finishes.
 */
export function buildAGUITextResponse(text: string): AGUIEvent[] {
	const threadId = randomId("thread");
	const runId = randomId("run");
	const messageId = randomId("msg");
	return [
		{ type: "RUN_STARTED", threadId, runId },
		{ type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
		{ type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
		{ type: "TEXT_MESSAGE_END", messageId },
		{ type: "RUN_FINISHED", threadId, runId },
	];
}

/** A scriptable AG-UI endpoint on a loopback port. */
export class AGUIMock {
	#fixtures: Fixture[] = [];
	#server: Bun.Server<undefined> | undefined;
	#options: { port?: number; hostname?: string };

	constructor(options: { port?: number; hostname?: string } = {}) {
		this.#options = options;
	}

	/** Answer a run whose last user message matches `pattern` with these events. */
	onRun(
		pattern: string | RegExp,
		events: AGUIEvent[],
		delayMs?: number,
	): this {
		this.#fixtures.push({
			accepts: (input) => matchesPattern(pattern, lastUserText(input)),
			events,
			delayMs: delayMs ?? 0,
		});
		return this;
	}

	/** Answer a run with this assistant text. */
	onMessage(
		pattern: string | RegExp,
		text: string,
		options: { delayMs?: number } = {},
	): this {
		return this.onRun(pattern, buildAGUITextResponse(text), options.delayMs);
	}

	/** Answer the runs a predicate accepts, with these events. */
	onPredicate(
		predicate: (input: AGUIRunInput) => boolean,
		events: AGUIEvent[],
		delayMs?: number,
	): this {
		this.#fixtures.push({
			accepts: predicate,
			events,
			delayMs: delayMs ?? 0,
		});
		return this;
	}

	/** Forget every fixture. */
	reset(): this {
		this.#fixtures = [];
		return this;
	}

	/** Start listening and answer with the AG-UI endpoint URL. */
	start(): Promise<string> {
		if (this.#server) return Promise.resolve(this.#server.url.href);
		this.#server = Bun.serve({
			port: this.#options.port ?? 0,
			hostname: this.#options.hostname ?? "127.0.0.1",
			fetch: (request) => this.#handle(request),
		});
		return Promise.resolve(this.#server.url.href);
	}

	/** Stop listening. Safe to call when it never started. */
	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (server) await server.stop(true);
	}

	get url(): string {
		return this.#server?.url.href ?? "";
	}

	async #handle(request: Request): Promise<Response> {
		if (request.method !== "POST")
			return Response.json({ error: "Only POST runs are mocked." }, { status: 405 });

		let input: AGUIRunInput = {};
		try {
			const parsed = (await request.json()) as unknown;
			if (parsed && typeof parsed === "object") input = parsed as AGUIRunInput;
		} catch {
			input = {};
		}

		const fixture = this.#fixtures.find((candidate) => candidate.accepts(input));
		if (!fixture)
			return Response.json(
				{ error: { message: "No AG-UI fixture matched the run." } },
				{ status: 404 },
			);
		if (fixture.delayMs > 0) await Bun.sleep(fixture.delayMs);

		const body = fixture.events
			.map((event) =>
				`data: ${JSON.stringify({ ...event, timestamp: Date.now() })}\n\n`,
			)
			.join("");
		return new Response(body, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}
}
