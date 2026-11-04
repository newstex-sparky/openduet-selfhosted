/**
 * The Bot's computer for the Phase 8b proof sandbox.
 *
 * A real deployment runs `agent-computer` (a browser in its own container). This one records every
 * call on the wire and answers `/click`, which is all the approval proof needs: the point is that
 * nothing reaches the computer while the approval is pending, and exactly one click arrives after
 * the operator allows it.
 */
const PORT = 4231;

type Recorded = {
	at: number;
	atIso: string;
	path: string;
	botId: string | null;
	tokenPresent: boolean;
	body: unknown;
};

const calls: Recorded[] = [];

Bun.serve({
	port: PORT,
	hostname: "0.0.0.0",
	fetch: async (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/calls") return Response.json(calls);
		if (url.pathname === "/reset") {
			calls.splice(0);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/health") return Response.json({ ok: true });

		const body = await request.json().catch(() => null);
		const at = Date.now();
		calls.push({
			at,
			atIso: new Date(at).toISOString(),
			path: url.pathname,
			botId: request.headers.get("x-openbot-bot-id"),
			tokenPresent: Boolean(request.headers.get("x-openbot-computer-token")),
			body,
		});
		console.log(
			JSON.stringify({ type: "computer-call", at, path: url.pathname }),
		);

		if (url.pathname === "/click")
			return Response.json({
				action: "click",
				ref: (body as { ref?: string } | null)?.ref ?? "e1",
				element: { role: "button", name: "Submit" },
				url: "https://example.test/form",
				elapsedMs: 4,
			});
		return Response.json({ ok: true, url: "https://example.test/form" });
	},
});

console.log(`[computer] listening on http://0.0.0.0:${PORT}`);
