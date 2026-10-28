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
let modelScript: ({ content: string } | { toolCalls: { name: string; arguments: string }[] })[] =
  [];
const llm = new LLMock();
let modelUrl = "";
/** Every click the stub computer was asked for. */
const computerCalls: { path: string; botId: string | null; body: unknown }[] = [];
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
  responses: ({ content: string } | { toolCalls: { name: string; arguments: string }[] })[],
): void {
  modelScript = [...responses];
  llm.onMessage(/.*/, () => {
    const next = modelScript.length > 1 ? modelScript.shift() : modelScript[0];
    return next ?? { content: "No script left." };
  });
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
      configuration: { systemPrompt: `You are ${name}. Answer in one short sentence.` },
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
async function createDueRoutine(agentId: string, channelId: string, instruction: string) {
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
  const child = Bun.spawn([process.execPath, "server/scripts/fire-routines.ts"], {
    cwd: openbotRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: databaseUrl,
      KEY_ENCRYPTION_KEY: EXAMPLE_KEY,
      OPENDUET_LOCAL_MODE: "true",
      WORKER_SHARED_SECRET: WORKER_SECRET,
      SERVER_INTERNAL_URL: publicUrl,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out: string[] = [];
  const err: string[] = [];
  await Promise.all([collect(child.stdout, out), collect(child.stderr, err)]);
  const code = await child.exited;
  const text = `${out.join("")}${err.join("")}`;
  if (code !== 0)
    throw new Error(`The sweep exited ${code}.\n${text}`);
  return text;
}

async function runsOf(routineId: string) {
  return await database
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.routineId, routineId));
}

/** The conversation the firing wrote, read from Postgres: the whole point of durable history. */
async function threadMessages(threadId: string) {
  const rows = await database.$client`
    select message_id, role, content
      from copilotkit_thread_messages
     where thread_id = ${threadId}
     order by seq
  `;
  return rows as unknown as { message_id: string; role: string; content: string }[];
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
    .values({ id: OWNER_ID, email: "dev@openbot.local", name: "Local Mode Owner" })
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
    await database.delete(agentProfiles).where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
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

  /* The reply landed in the channel's conversation, in Postgres, not in either process's memory. */
  const messages = await threadMessages(channel.threadId);
  expect(messages.map((message) => message.role)).toContain("assistant");
  expect(
    messages.some((message) =>
      String(message.content).includes("Standup: nothing is blocking today."),
    ),
  ).toBe(true);

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
  const waiting = await waitFor("the routine run to wait for approval", async () => {
    const [row] = await runsOf(routine.id);
    return row?.status === "waiting" ? row : undefined;
  });
  const approvalId = String(
    (waiting.waiting as { approvalId?: string; requestId?: string } | null)
      ?.approvalId ??
      (waiting.waiting as { requestId?: string } | null)?.requestId,
  );
  expect(approvalId).not.toBe("undefined");
  /* Nothing reached the computer while it waited. */
  expect(computerCalls.filter((call) => call.path === "/click")).toHaveLength(0);

  /* The person allows it, over the deployment's own HTTP API. */
  const decision = await fetch(`${publicUrl}/api/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "allow_once" }),
  });
  expect(decision.status).toBe(200);
  expect(await decision.json()).toMatchObject({ status: "approved" });

  /* Resumed: the approved action ran against the computer, and the turn finished. */
  const finished = await waitFor("the routine run to finish after approval", async () => {
    const [row] = await runsOf(routine.id);
    return row?.status === "succeeded" ? row : undefined;
  });
  expect(finished.status).toBe("succeeded");

  const clicks = computerCalls.filter((call) => call.path === "/click");
  expect(clicks).toHaveLength(1);
  expect(clicks[0]?.botId).toBe(agentId);
  expect(clicks[0]?.body).toMatchObject({ ref: "e1", snapshotId: 1 });

  const messages = await threadMessages(channel.threadId);
  expect(
    messages.some((message) =>
      String(message.content).includes("The form was submitted."),
    ),
  ).toBe(true);
}, 120_000);
