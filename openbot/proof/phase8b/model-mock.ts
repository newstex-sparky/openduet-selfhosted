/**
 * The model API for the Phase 8b proof sandbox.
 *
 * This is the repository's own LLMock (`server/testing/llmock.ts`), not a stub invented for the
 * card. It stands in for the one thing an operator supplies in a self-hosted deployment: an
 * OpenAI-compatible endpoint. Everything else in the sandbox is the fork's own code.
 *
 * Each branch below is keyed on a phrase the driver types into the companion web app, so a proof
 * waits on a known answer instead of on a real model's mood. Proofs 1 and 2 do not use this file at
 * all: they run against the real model endpoint on the 8a stack.
 *
 * A journal of every request is served on the control port, so a proof can show WHEN the model was
 * asked and WHEN it answered (that gap is the whole point of proof 6).
 */
import { LLMock, type MockRequestBody } from "../../server/testing/llmock";

const PORT = 7031;
const CONTROL_PORT = 7032;

type ChatMessage = { role?: string; content?: unknown };
type Resolved = {
	content?: string;
	toolCalls?: { id: string; name: string; arguments: string }[];
};

function messagesOf(body: MockRequestBody): ChatMessage[] {
	const raw = (body as { messages?: unknown }).messages;
	return Array.isArray(raw) ? (raw as ChatMessage[]) : [];
}

function textOf(message: ChatMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((part) =>
				part && typeof part === "object" && "text" in part
					? String((part as { text: unknown }).text)
					: "",
			)
			.join("");
	return "";
}

function lastUserText(body: MockRequestBody): string {
	const users = messagesOf(body).filter((message) => message.role === "user");
	return textOf(users.at(-1) ?? {});
}

function sawToolResult(body: MockRequestBody): boolean {
	const messages = messagesOf(body);
	let lastUser = -1;
	for (const [index, message] of messages.entries())
		if (message.role === "user") lastUser = index;
	return messages
		.slice(lastUser + 1)
		.some((message) => message.role === "tool");
}

/**
 * The minute and hour, in UTC, two minutes from now.
 *
 * A routine may fire at most every fifteen minutes, so `* *` style schedules are refused by the
 * tool. Naming the exact minute and hour is a once-a-day schedule, which is allowed and which the
 * scheduler sweep then fires two minutes later.
 */
function twoMinutesAheadUtc(): { minute: number; hour: number; due: string } {
	const due = new Date(Date.now() + 2 * 60_000);
	return {
		minute: due.getUTCMinutes(),
		hour: due.getUTCHours(),
		due: due.toISOString(),
	};
}

const llm = new LLMock({ port: PORT, hostname: "0.0.0.0" });

llm.onMessage(/.*/, async (body: MockRequestBody): Promise<Resolved> => {
	const prompt = lastUserText(body);
	const started = Date.now();
	console.log(
		JSON.stringify({
			type: "model-request",
			at: started,
			atIso: new Date(started).toISOString(),
			prompt: prompt.slice(0, 160),
		}),
	);

	/* (a0) the approval gate's own reviewer, which the deployment asks before any changing action. */
	if (prompt.includes("You review one action an AI assistant is about to take")) {
		/*
		 * The reviewer prompt carries the person's request and the action, so the same phrases the
		 * operator's turn used are visible here. Anything the proofs do that is not the approval
		 * case is clearly within what was asked, so the reviewer proceeds; the approval case is the
		 * one the reviewer asks a person about, which is what makes proof 5 a real pause rather
		 * than a mock one.
		 */
		const needsApproval = prompt.includes("APPROVAL8B");
		return {
			content: JSON.stringify({
				verdict: needsApproval ? "needs_approval" : "proceed",
				preApproved: !needsApproval,
				safety: "none",
				reason: needsApproval
					? "The person should see this click before it happens."
					: "The person asked for this exact action in this turn.",
			}),
		};
	}

	/* (a) the thread lock: hold the run open long enough for a second action to be refused 409. */
	if (prompt.includes("LOCK8B")) {
		await new Promise((resolve) => setTimeout(resolve, 45_000));
		return { content: "LOCK8B holder finished." };
	}

	/*
	 * (b) a turn whose model says NOTHING for longer than Bun's ten-second server idle timeout.
	 * With no SSE keep-alive the browser never sees this reply; with it, the reply arrives on the
	 * same open response.
	 */
	if (prompt.includes("SLOW8B")) {
		await new Promise((resolve) => setTimeout(resolve, 14_000));
		return {
			content: "SLOW8B reply arrived after fourteen seconds of model silence.",
		};
	}

	/* (c) a routine created from the conversation, exactly as the Bot's own tool writes it. */
	if (prompt.includes("ROUTINE8B-SETUP")) {
		if (sawToolResult(body))
			return {
				content:
					"ROUTINE8B the routine is set; it posts here on its schedule.",
			};
		const at = twoMinutesAheadUtc();
		console.log(
			JSON.stringify({ type: "routine-create", due: at.due, cron: `${at.minute} ${at.hour} * * *` }),
		);
		return {
			toolCalls: [
				{
					id: "call_create_routine_8b",
					// The name the model is actually offered: `toolNameFor` in
					// server/src/plugins/plugin-store/model.ts prefixes a granted tool's ref with
					// `mcp__` and turns the server/tool separator into `__`. A plain
					// `create_routine` is not in the list the runtime hands over, and the engine
					// answers such a call with "Model tried to call unavailable tool".
					name: "mcp__routines__create_routine",
					arguments: JSON.stringify({
						instruction: "ROUTINE8B fired turn: post the standup summary",
						cron: `${at.minute} ${at.hour} * * *`,
						timezone: "UTC",
					}),
				},
			],
		};
	}

	/* (d) the routine's own turn, run headless by the scheduler service when it comes due. */
	if (prompt.includes("ROUTINE8B fired turn")) {
		return {
			content: `ROUTINE8B scheduled turn ran at ${new Date().toISOString()} with nobody typing.`,
		};
	}

	/* (e) the approval-gated action: ask for the click once, then close the turn. */
	if (prompt.includes("APPROVAL8B")) {
		if (sawToolResult(body))
			return { content: "APPROVAL8B the form was submitted." };
		return {
			toolCalls: [
				{
					id: "call_computer_click_8b",
					name: "computer_click",
					arguments: JSON.stringify({ ref: "e1", snapshotId: 1 }),
				},
			],
		};
	}

	return { content: `no rule matched: ${prompt.slice(0, 80)}` };
});

const base = await llm.start();
console.log(`[model] listening on ${base} (port ${PORT})`);

Bun.serve({
	port: CONTROL_PORT,
	hostname: "0.0.0.0",
	fetch: (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/requests")
			return Response.json(
				llm.getRequests().map((entry) => ({
					path: entry.path,
					at: entry.timestamp,
					atIso: new Date(entry.timestamp).toISOString(),
				})),
			);
		return Response.json({ service: "model" });
	},
});
console.log(`[model] control on http://0.0.0.0:${CONTROL_PORT}`);
