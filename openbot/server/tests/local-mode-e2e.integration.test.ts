/**
 * LOCAL MODE, END TO END: a routine fires and finishes a turn, and a gated action pauses for a
 * person and carries on after they allow it.
 *
 * Everything here is the deployment's own machinery, nothing is the thing under test:
 * the real `server/src/index.ts` in a child process, the real `scripts/fire-routines.ts` sweep the
 * CronJob runs, the real Postgres thread platform and run lock (`docs/local-mode.md`, Phase 2), the
 * routine runner, the approval service and gate, and the approval resume sweep. Only the two things
 * a test may not own are stood in: the model (a loopback OpenAI-compatible service, `LLMock`) and
 * the Bot's browser (a loopback computer that answers `/click`).
 *
 * WHY A CHILD PROCESS AND NOT `createApp`. The claim these cases make is that local mode is a
 * deployment somebody can run, so what is asserted is what that deployment writes: the routine run
 * row, the conversation in Postgres, and the server's own log lines. Booting `index.ts` is also the
 * only way to get the boot-time wiring — the local platform, the worker secret, the mounted
 * `/internal/routines/run` — rather than a hand-assembled copy of it that could agree with the test
 * and not with the product.
 *
 * BOTH CASES NEED A DATABASE THAT PERSISTS ACROSS PROCESSES, which is the point of Phase 2: the
 * sweep runs in one process, the turn in another, the approval decision arrives over HTTP, and the
 * resume sweep runs in the server. Every assertion reads Postgres, not memory.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LLMock } from "@copilotkit/aimock";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  routines,
  routineRuns,
  users,
} from "../src/db/schema";
import { createRoutineStore } from "../src/routines/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The key `.env.example` ships. Public, and fine for a loopback test. */
const EXAMPLE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
/** The one administrator a deployment with no identity provider signs everybody in as. */
const OWNER_ID = "dev-local-user";
const WORKER_SECRET = `local-mode-e2e-${randomUUID()}`;
const COMPUTER_TOKEN = `local-mode-computer-${randomUUID()}`;
/** Daily, comfortably above the floor. The row is made due directly; see `makeDueNow`. */
const DAILY = "0 9 * * *";

/** The repository's `openbot/` tree: this file lives in `openbot/server/tests`. */
const openbotRoot = new URL("../../", import.meta.url).pathname;
const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const owner: AgentActor = { id: OWNER_ID, role: "admin" };
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity(`local-mode-e2e-${randomUUID()}`),
);
const routineStore = createRoutineStore(database);

const prefix = `local-mode-e2e-${randomUUID()}`;
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

/** The model's script, in request order. See `scriptModel`. */
let modelScript: (
  | { content: string }
  | { toolCalls: { name: string; arguments: string }[] }
)[] = [];
const llm = new LLMock();
let modelUrl = "";
/** Every click the stub computer was asked for. */
const computerCalls: { path: string; botId: string | null; body: unknown }[] =
  [];
let computer: ReturnType<typeof Bun.serve> | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
const serverLog: string[] = [];
let publicUrl = "";

/** A free port. Bound and released, because the server needs the number before it starts. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("Could not find a free port for the server.");
  return port;
}

/** Drain a child's stream into `into`, so its log is readable after the fact. */
async function collect(stream: unknown, into: string[]): Promise<void> {
  // `Bun.spawn` types `stdout` as a stream only for `"pipe"`; the union is widened by the helper.
  if (!stream || typeof stream === "number") return;
  const source = stream as ReadableStream<Uint8Array>;
  const reader = source.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    into.push(decoder.decode(value));
  }
}

const serverOutput = () => serverLog.join("");

async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined | null>,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${what}.\n--- server log ---\n${serverOutput().slice(-4000)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Script the model, one response per request.
 *
 * A queue rather than a match on the prompt: these cases are about what the deployment does with a
 * reply, and a fixture that also had to recognise its own prompts would fail for a reason that has
 * nothing to do with the behaviour under test. The last entry repeats, so a turn that takes an
 * extra step still finishes rather than hanging on an empty script.
 */
function scriptModel(
  responses: (
    | { content: string }
    | { toolCalls: { name: string; arguments: string }[] }
  )[],
): void {
  modelScript = [...responses];
  llm.onMessage(/.*/, async () => {
    if (modelDelayMs > 0) await Bun.sleep(modelDelayMs);
    const next = modelScript.length > 1 ? modelScript.shift() : modelScript[0];
    return next ?? { content: "No script left." };
  });
}

/** How long the scripted model sits silent before it answers. Reset by the case that sets it. */
let modelDelayMs = 0;

/**
 * One chat turn over the deployment's own HTTP surface: `POST /api/copilotkit/agent/openduet/run`,
 * the request a browser sends, read to the end of its SSE stream.
 *
 * What a client can see is the point, so this keeps the status and content type and every event
 * the stream carried, and reads the whole body: a stream the server cut short throws here, which is
 * exactly the failure a slow model used to cause.
 */
async function runOverHttp(threadId: string, runId: string, text: string) {
  const response = await fetch(
    `${publicUrl}/api/copilotkit/agent/openduet/run`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        runId,
        messages: [{ id: randomUUID(), role: "user", content: text }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    },
  );
  const body = await response.text();
  const events = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map(
      (line) => JSON.parse(line.slice(6)) as { type: string; delta?: string },
    );
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body,
    types: events.map((event) => event.type),
    text: events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta ?? "")
      .join(""),
  };
}

/** A Bot the deployment can run: a built-in one, which is the local platform's model path. */
async function createBuiltInBot(name: string): Promise<string> {
  const profile = await profileStore.create(owner, {
    name,
    title: "Ops",
    roleDescription: `Runs ${name} work.`,
    visibility: "public",
  });
  createdAgentIds.push(profile.id);
  /*
   * `create` registers the deployment's managed endpoint when the caller gives none, and this test
   * has no managed endpoint. A built-in Bot is what local mode runs, and it needs a prompt:
   * `registeredAgentFromRow` drops a `built_in` row whose prompt is empty, and the routine would
   * then fail with "That Bot is no longer registered".
   */
  await database
    .update(agents)
    .set({
      type: "built_in",
      configuration: {
        systemPrompt: `You are ${name}. Answer in one short sentence.`,
      },
    })
    .where(eq(agents.id, profile.id));
  return profile.id;
}

async function createChannel(agentId: string) {
  const channel = await channelStore.create(owner, [agentId]);
  createdChannelIds.push(channel.id);
  return channel;
}

/** A due routine: created through the store, then stamped due by hand (create only looks forward). */
async function createDueRoutine(
  agentId: string,
  channelId: string,
  instruction: string,
) {
  const routine = await routineStore.create({
    ownerUserId: OWNER_ID,
    agentId,
    channelId,
    instruction,
    cron: DAILY,
  });
  await database
    .update(routines)
    .set({ nextRunAt: new Date(Date.now() - 60_000) })
    .where(eq(routines.id, routine.id));
  return routine;
}

/** One firing of the CronJob's sweep, as a process, so its output is evidence rather than a claim. */
async function sweep(): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, "server/scripts/fire-routines.ts"],
    {
      cwd: openbotRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: databaseUrl,
        KEY_ENCRYPTION_KEY: EXAMPLE_KEY,
        OPENDUET_LOCAL_MODE: "true",
        /*
         * The sweep calls the same `loadConfig` the server does, and a deployment with no identity
         * provider refuses to boot without this. The server child below is given it for that reason;
         * leaving it off the sweep's environment made the CronJob's own process fail at start-up
         * while the server it reports to was running, which reads as a broken routine rather than a
         * misconfigured sweep. The same key, so both processes agree on the one administrator.
         */
        OPENBOT_SINGLE_USER: "true",
        WORKER_SHARED_SECRET: WORKER_SECRET,
        SERVER_INTERNAL_URL: publicUrl,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out: string[] = [];
  const err: string[] = [];
  await Promise.all([collect(child.stdout, out), collect(child.stderr, err)]);
  const code = await child.exited;
  const text = `${out.join("")}${err.join("")}`;
  if (code !== 0) throw new Error(`The sweep exited ${code}.\n${text}`);
  return text;
}

async function runsOf(routineId: string) {
  return await database
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.routineId, routineId));
}

/**
 * The sweep's own JSON line, lifted out of its output.
 *
 * A passing assertion says the routine fired; this makes a passing run *show* it, so the evidence
 * is in the test log rather than only in the matcher.
 */
function sweepEvidence(output: string): string {
  const line = output
    .split("\n")
    .find((candidate) => candidate.includes('"type":"routine-sweep"'));
  return line?.trim() ?? output.trim().slice(0, 600);
}

/** The conversation the firing wrote, read from Postgres: the whole point of durable history. */
async function threadMessages(threadId: string) {
  const rows = await database.$client`
    select message_id, role, content
      from copilotkit_thread_messages
     where thread_id = ${threadId}
     order by seq
  `;
  return rows as unknown as {
    message_id: string;
    role: string;
    content: string;
  }[];
}

type ApprovalRow = {
  id: string;
  run_id: string | null;
  status: string;
  decision: string | null;
  tool_call_id: string | null;
  tool_ref: string | null;
  bot_id: string | null;
  thread_id: string | null;
  result: { content?: string; error?: string } | null;
  decided_at: Date | null;
  consumed_at: Date | null;
  completed_at: Date | null;
};

/**
 * The gate's own row, by SQL.
 *
 * The run row's `waiting` column is the runner's account of the pause; this is the request the
 * gate opened, which is what a person answers and what carries the result once it resumes. Read
 * here rather than through the service, because a test that asked the service would be asking the
 * same object that wrote the row.
 */
async function approvalRow(id: string): Promise<ApprovalRow | undefined> {
  const rows = (await database.$client`
    select id, run_id, status, decision, tool_call_id,
           action->>'toolRef' as tool_ref,
           action->>'botId' as bot_id,
           action->>'threadId' as thread_id,
           result, decided_at, consumed_at, completed_at
      from approval_requests
     where id = ${id}
  `) as unknown as ApprovalRow[];
  return rows[0];
}

/** The trail entry the decision path writes, so "a person allowed it" is a row and not a claim. */
async function decisionAudit(id: string) {
  return (await database.$client`
    select event_type, target_id, actor_user_id,
           payload->>'decidedBy' as decided_by,
           payload->>'decision' as decision,
           payload->>'tool' as tool
      from audit_events
     where event_type = 'approval.person_decided' and target_id = ${id}
     order by created_at
  `) as unknown as {
    event_type: string;
    target_id: string;
    actor_user_id: string | null;
    decided_by: string | null;
    decision: string | null;
    tool: string | null;
  }[];
}

/** The Postgres runner's records of the turns in this conversation, one per run. */
async function threadRuns(threadId: string) {
  return (await database.$client`
    select run_id, status, error, finished_at
      from copilotkit_thread_runs
     where thread_id = ${threadId}
     order by started_at
  `) as unknown as {
    run_id: string;
    status: string;
    error: string | null;
    finished_at: Date | null;
  }[];
}

/**
 * Print the rows this case proved.
 *
 * The card asks for a row dump as well as a passing assertion, and the rows are gone after
 * `afterAll` removes the Bot, so they are printed here, while the turn they describe is still in
 * the database.
 */
async function dumpApprovalEvidence(input: {
  approvalId: string;
  routineId: string;
  threadId: string;
}) {
  const blocks = {
    approval_requests: await approvalRow(input.approvalId),
    routine_runs: await runsOf(input.routineId),
    copilotkit_thread_runs: await threadRuns(input.threadId),
    copilotkit_thread_messages: await threadMessages(input.threadId),
    "audit_events approval.person_decided": await decisionAudit(
      input.approvalId,
    ),
  };
  const text = Object.entries(blocks)
    .map(([name, rows]) => `--- ${name} ---\n${JSON.stringify(rows, null, 2)}`)
    .join("\n");
  console.log(
    `\n=== Postgres rows after the approved action ran ===\n${text}\n`,
  );
  return text;
}

beforeAll(async () => {
  modelUrl = await llm.start();

  /* The computer seam: a real HTTP service answering the one action this test asks for. */
  computer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      computerCalls.push({
        path,
        botId: request.headers.get("x-openbot-bot-id"),
        body: await request.json().catch(() => null),
      });
      if (path === "/click")
        return Response.json({
          action: "click",
          ref: "e1",
          element: { role: "button", name: "Submit" },
          url: "https://example.test/form",
          elapsedMs: 4,
        });
      return Response.json({ ok: true, url: "https://example.test/form" });
    },
  });

  const port = freePort();
  publicUrl = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    DATABASE_URL: databaseUrl,
    KEY_ENCRYPTION_KEY: EXAMPLE_KEY,
    OPENDUET_LOCAL_MODE: "true",
    OPENBOT_SINGLE_USER: "true",
    SERVER_PORT: String(port),
    PORT: String(port),
    OPENBOT_PUBLIC_URL: publicUrl,
    TENANT_PACKAGE_DIR: "examples/openduet",
    OPENAI_API_KEY: "sk-local-mode-e2e",
    OPENAI_BASE_URL: modelUrl,
    AGENT_COMPUTER_URL: `http://127.0.0.1:${computer.port ?? 0}`,
    COMPUTER_TOKEN,
    WORKER_SHARED_SECRET: WORKER_SECRET,
  };
  server = Bun.spawn([process.execPath, "server/src/index.ts"], {
    cwd: openbotRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  void collect(server.stdout, serverLog);
  void collect(server.stderr, serverLog);

  await waitFor("the server to listen", async () =>
    serverOutput().includes("OpenDuet server listening") ? true : undefined,
  );

  /* The server booted the single administrator; the routines below run as that person. */
  await database
    .insert(users)
    .values({
      id: OWNER_ID,
      email: "dev@openbot.local",
      name: "Local Mode Owner",
    })
    .onConflictDoNothing();

  /*
   * A previous run's resume queue entries would otherwise tick in this server every two seconds and
   * log `approval-resume-error: This approval could not be found.` — true about a row a cleanup
   * already deleted, and noise in the log this file reads as evidence.
   */
  await database.$client`delete from work_items where kind = 'approval.resume'`;
}, 120_000);

afterAll(async () => {
  server?.kill();
  computer?.stop(true);
  for (const channelId of createdChannelIds.splice(0))
    await database.delete(channels).where(eq(channels.id, channelId));
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  /* The conversations the HTTP cases opened on the tenant's Bot; their runs, events and messages
   * cascade with them. */
  await database.$client`delete from copilotkit_threads where id like ${`${prefix}%`}`;
  await database.$client.close();
  await llm.stop();
}, 60_000);

test("a scheduled routine fires and completes its turn in local mode", async () => {
  scriptModel([{ content: "Standup: nothing is blocking today." }]);
  const agentId = await createBuiltInBot(`${prefix} standup`);
  const channel = await createChannel(agentId);
  const routine = await createDueRoutine(
    agentId,
    channel.id,
    "Post the standup summary.",
  );

  const sweepOutput = await sweep();
  /* The CronJob's own wording: this routine was the one it handed to the server. */
  expect(sweepOutput).toContain(`"fired":["${routine.id}"]`);
  console.log(`[e2e] sweep fired the routine: ${sweepEvidence(sweepOutput)}`);

  const run = await waitFor("the routine run to finish", async () => {
    const [row] = await runsOf(routine.id);
    return row?.status ? row : undefined;
  });
  /*
   * The row's own words on failure: `error` is the whole diagnosis a routine firing leaves, and an
   * assertion that only says "failed" would send the next reader hunting for it.
   */
  expect({ status: run.status, error: run.error }).toEqual({
    status: "succeeded",
    error: null,
  });
  console.log(
    `[e2e] routine_runs row closed: ${JSON.stringify({
      id: run.id,
      routineId: run.routineId,
      status: run.status,
      error: run.error,
      finishedAt: run.finishedAt,
    })}`,
  );

  /* The reply landed in the channel's conversation, in Postgres, not in either process's memory. */
  const messages = await threadMessages(channel.threadId);
  expect(messages.map((message) => message.role)).toContain("assistant");
  expect(
    messages.some((message) =>
      String(message.content).includes("Standup: nothing is blocking today."),
    ),
  ).toBe(true);
  console.log(
    `[e2e] copilotkit_thread_messages read back for ${channel.threadId}: ${JSON.stringify(
      messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    )}`,
  );

  /* The firing was served in local mode, and the server said so about the turn it ran. */
  expect(serverOutput()).toContain('"type":"openduet-local-mode"');
}, 120_000);

test("an approval-gated action pauses the turn, and carries on after the person allows it", async () => {
  scriptModel([
    {
      toolCalls: [
        {
          name: "computer_click",
          arguments: JSON.stringify({ ref: "e1", snapshotId: 1 }),
        },
      ],
    },
    { content: "The form was submitted." },
  ]);
  const agentId = await createBuiltInBot(`${prefix} submit`);
  const channel = await createChannel(agentId);
  const routine = await createDueRoutine(
    agentId,
    channel.id,
    "Submit the form on the page.",
  );

  const sweepOutput = await sweep();
  /* The CronJob's own wording: this routine was the one it handed to the server. */
  expect(sweepOutput).toContain(`"fired":["${routine.id}"]`);

  /* Paused: the run row says waiting, and the wait names the approval a person has to answer. */
  const waiting = await waitFor(
    "the routine run to wait for approval",
    async () => {
      const [row] = await runsOf(routine.id);
      return row?.status === "waiting" ? row : undefined;
    },
  );
  const approvalId = String(
    (waiting.waiting as { approvalId?: string; requestId?: string } | null)
      ?.approvalId ??
      (waiting.waiting as { requestId?: string } | null)?.requestId,
  );
  expect(approvalId).not.toBe("undefined");
  /*
   * The gate's own row, while the turn waits: pending, undecided, about this Bot's click in this
   * conversation. A run row that said `waiting` about a request nobody could answer would be a
   * pause with no way out, so both rows are read.
   */
  const pending = await approvalRow(approvalId);
  expect(pending).toBeDefined();
  expect({
    status: pending?.status,
    decision: pending?.decision,
    tool: pending?.tool_ref,
    bot: pending?.bot_id,
    thread: pending?.thread_id,
  }).toEqual({
    status: "pending",
    decision: null,
    tool: "computer_click",
    bot: agentId,
    thread: channel.threadId,
  });
  expect(pending?.decided_at).toBeNull();
  expect(pending?.consumed_at).toBeNull();
  expect(pending?.completed_at).toBeNull();
  /* Nothing reached the computer while it waited. */
  const clicksWhileWaiting = computerCalls.filter(
    (call) => call.path === "/click",
  );
  expect(clicksWhileWaiting).toHaveLength(0);
  /* The paused state, printed while it is still the current state. */
  console.log(
    [
      "\n=== Postgres rows while the turn waits ===",
      `--- routine_runs (the paused run) ---\n${JSON.stringify(waiting, null, 2)}`,
      `--- approval_requests (the request a person answers) ---\n${JSON.stringify(pending, null, 2)}`,
      `--- computer /click calls so far ---\n${JSON.stringify(clicksWhileWaiting)}`,
    ].join("\n"),
  );

  /* The person allows it, over the deployment's own HTTP API. */
  const decision = await fetch(
    `${publicUrl}/api/approvals/${approvalId}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow_once" }),
    },
  );
  expect(decision.status).toBe(200);
  expect(await decision.json()).toMatchObject({ status: "approved" });

  /*
   * The decision landed on the row and on the trail. The status is read immediately after the
   * response, and the resume sweep may already have picked the request up, so the assertion
   * allows every state a decided request can be in and pins the part that must never change: the
   * person's decision, its time, and who made it.
   */
  const decided = await approvalRow(approvalId);
  expect(decided?.decision).toBe("allow_once");
  expect(decided?.decided_at).not.toBeNull();
  expect(["approved", "consumed", "completed"]).toContain(
    String(decided?.status),
  );
  const trail = await decisionAudit(approvalId);
  expect(trail.map((entry) => entry.decided_by)).toEqual(["person"]);
  expect(trail[0]?.decision).toBe("allow_once");
  expect(trail[0]?.tool).toBe("computer_click");

  /* Resumed: the approved action ran against the computer, and the turn finished. */
  const finished = await waitFor(
    "the routine run to finish after approval",
    async () => {
      const [row] = await runsOf(routine.id);
      return row?.status === "succeeded" ? row : undefined;
    },
  );
  expect(finished.status).toBe("succeeded");
  /* The pause is over and the row says so: no `waiting` payload left on a finished run. */
  expect(finished.waiting).toBeNull();
  expect(finished.finishedAt).not.toBeNull();

  /*
   * The request itself is closed, and the result it carries is what the approved action returned
   * from the computer — the stub's own JSON — so "it resumed and completed" is the gate's row and
   * not only the runner's.
   */
  const completed = await approvalRow(approvalId);
  expect(completed?.status).toBe("completed");
  expect(completed?.consumed_at).not.toBeNull();
  expect(completed?.completed_at).not.toBeNull();
  /* `toEqual`, not `?.error` + `toBeUndefined`: a missing result must fail, and so must an `error`. */
  expect(completed?.result).toEqual({
    content: expect.stringContaining("https://example.test/form"),
  });
  expect(String(completed?.result?.content)).toContain(
    "https://example.test/form",
  );

  /* The Postgres runner recorded the turn that paused, and recorded it finishing. */
  const runs = await threadRuns(channel.threadId);
  const approvedRun = runs.find((row) => row.run_id === pending?.run_id);
  expect(approvedRun).toMatchObject({ status: "finished", error: null });
  expect(completed?.run_id).toBe(pending?.run_id);

  const clicks = computerCalls.filter((call) => call.path === "/click");
  expect(clicks).toHaveLength(1);
  expect(clicks[0]?.botId).toBe(agentId);
  expect(clicks[0]?.body).toMatchObject({ ref: "e1", snapshotId: 1 });

  const messages = await threadMessages(channel.threadId);
  /*
   * The whole turn is in the thread store: the instruction, the model's tool call for the gated
   * action, the tool result the approved action returned, and the model's closing reply.
   */
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  expect(
    messages.some((message) =>
      String(message.content).includes("The form was submitted."),
    ),
  ).toBe(true);

  /* The rows the case proved, printed while they still exist. */
  const evidence = await dumpApprovalEvidence({
    approvalId,
    routineId: routine.id,
    threadId: channel.threadId,
  });
  expect(evidence).toContain("The form was submitted.");
}, 120_000);

test("a run whose model is silent for longer than Bun's idle timeout still streams its reply", async () => {
  /*
   * `Bun.serve` closes a connection that has sent nothing for 10 seconds, and the runtime's own SSE
   * keep-alive defaulted to 15, so this run used to lose its stream after RUN_STARTED while the run
   * itself finished and was stored. Twelve seconds of silence is past Bun's limit and under the
   * case's own timeout.
   */
  scriptModel([{ content: "The slow model answered." }]);
  modelDelayMs = 12_000;
  try {
    const run = await runOverHttp(
      `${prefix}-slow-${randomUUID()}`,
      randomUUID(),
      "Take your time.",
    );
    expect({
      status: run.status,
      first: run.types[0],
      last: run.types.at(-1),
      text: run.text,
    }).toEqual({
      status: 200,
      first: "RUN_STARTED",
      last: "RUN_FINISHED",
      text: "The slow model answered.",
    });
    /* What kept it open: the runtime's SSE comment, which AG-UI parsers drop. */
    expect(run.body).toContain(": keep-alive");
  } finally {
    modelDelayMs = 0;
  }
}, 60_000);
