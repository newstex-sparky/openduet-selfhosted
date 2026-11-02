import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  cliLoginPresent,
  containerMissing,
  ensureLearningContainer,
  json,
  type KeyIntelligence,
  keyIntelligence,
  learningSetupInstructions,
  MANAGED_API,
  object,
  type RunCli,
  runCli,
  verifiedContainer,
} from "../server/src/learning/ensure-container";

export type { KeyIntelligence } from "../server/src/learning/ensure-container";

const CONTAINER = "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID";

/**
 * - `configured`: fresh setup wrote a runtime key and the container to `.env`.
 * - `preserved`: the environment already names a container.
 * - `present`: the runtime key's project already has `openbot`; the server assigns it.
 * - `created`: `openbot` was created in the runtime key's project; the server assigns it.
 * - `skipped`: run without a person (`--non-interactive`) and nothing can be done without one.
 */
export type SetupLearningResult =
  | "configured"
  | "preserved"
  | "present"
  | "created"
  | "skipped";

function upsert(content: string, name: string, value: string) {
  const without = content
    .split(/\r?\n/)
    .filter(
      (line) => !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line),
    )
    .join("\n");
  return `${without.replace(/\n*$/, "\n")}${name}=${JSON.stringify(value)}\n`;
}

async function saveEnvironment(envPath: string, content: string) {
  const temporary = `${envPath}.learning-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, envPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The canonical origin of the configured API URL.
 *
 * The browser sign-in that wanted a stricter check (HTTPS, or HTTP on loopback) went with
 * `self-hosted-learning.ts`; what is left passes the origin to `ensure-container`, which does its
 * own request and fails loudly on an unreachable one.
 */
function apiOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(
      "Set INTELLIGENCE_API_URL to a complete URL, such as https://api.example.com, and run this helper again.",
    );
  }
}

/** Fresh setup owns key provisioning, so its container and key share a verified project. */
export async function setupLearning(
  options: {
    directory?: string;
    environment?: Record<string, string | undefined>;
    runCli?: RunCli;
    /** No browser, no prompt and no new key: what `scripts/start.sh` runs on every start. */
    nonInteractive?: boolean;
    /**
     * Whether a CopilotKit CLI login may be on this machine. False skips the CLI entirely, so a
     * start on a machine that never signed in does not download it. Unset means try it.
     */
    cliLogin?: boolean;
    keyIntelligence?: (
      apiUrl: string,
      apiKey: string,
      wsUrl?: string,
    ) => KeyIntelligence;
  } = {},
): Promise<SetupLearningResult> {
  const directory = resolve(options.directory ?? process.cwd());
  const environment = options.environment ?? process.env;
  const run = options.runCli ?? runCli;
  const envPath = resolve(directory, ".env");
  const original = await readFile(envPath, "utf8").catch(() => {
    throw new Error(
      "Run this helper from the directory that holds .env (the repository root in OpenDuet) after copying .env.example to .env.",
    );
  });
  const values = parseEnv(original);
  const effective = (name: string) =>
    (environment[name] || values[name] || "").trim();
  if (effective(CONTAINER)) return "preserved";
  const existingKey = effective("INTELLIGENCE_API_KEY");
  if (existingKey) {
    /*
     * The key cannot create containers, and it is never replaced here. Creation goes through a
     * credential that can (learning/ensure-container.ts) and counts only once the key itself can see
     * the result. The server then assigns it; nothing is written to `.env`.
     */
    const apiUrl = apiOrigin(effective("INTELLIGENCE_API_URL"));
    const serviceToken = effective("INTELLIGENCE_SERVICE_TOKEN");
    const projectId = effective("INTELLIGENCE_PROJECT_ID");
    return ensureLearningContainer({
      directory,
      apiUrl,
      nonInteractive: options.nonInteractive === true,
      run,
      key: (options.keyIntelligence ?? keyIntelligence)(
        apiUrl,
        existingKey,
        effective("INTELLIGENCE_GATEWAY_WS_URL") || undefined,
      ),
      ...(serviceToken && projectId
        ? { serviceToken: { token: serviceToken, projectId } }
        : {}),
      ...(options.cliLogin === undefined ? {} : { cliLogin: options.cliLogin }),
    });
  }
  // Provisioning a key edits .env: a person runs that, not a start script.
  if (options.nonInteractive) return "skipped";
  const apiUrl = apiOrigin(effective("INTELLIGENCE_API_URL"));
  if (apiUrl !== MANAGED_API) {
    /*
     * This used to open a browser against the deployment's own sign-in, through
     * `self-hosted-learning.ts`. That helper is gone with the desktop sign-in it existed for, and
     * nothing here can mint a key without a person either way.
     */
    throw new Error(
      "This helper provisions a key only for the managed service. For a deployment of your own, set INTELLIGENCE_API_URL and INTELLIGENCE_API_KEY directly and run this helper again.",
    );
  }
  const projectPath = resolve(directory, ".copilotkit/project.json");
  const selected = json(
    await readFile(projectPath, "utf8").catch(() => {
      throw new Error(
        "Run npx --yes copilotkit@latest login and project select first, from the directory that holds .env (the repository root in OpenDuet).",
      );
    }),
  );
  const projectId = selected.projectId;
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new Error(
      "The selected project is invalid. Run npx --yes copilotkit@latest project select again.",
    );
  }
  // A saved record alone does not prove a stale CPK key belongs to it. Re-provision here.
  // This path runs only when no INTELLIGENCE_API_KEY is set: an existing one takes the branch above
  // and is never replaced, because CLI project select removes INTELLIGENCE_API_KEY from .env. What
  // it provisions arrives as CPK_INTELLIGENCE_API_KEY, which is copied to INTELLIGENCE_API_KEY at
  // the end, after the container is verified.
  const provision = await run(
    ["project", "select", "--project", projectId, "--json"],
    directory,
  );
  const selection = json(provision.stdout);
  if (
    provision.exitCode !== 0 ||
    selection.type !== "completed" ||
    selection.api_key_provisioned !== true ||
    selection.environment_file_written !== true ||
    !object(selection.project) ||
    selection.project.id !== projectId
  ) {
    throw new Error(
      "CopilotKit did not finish provisioning the selected project key. Sign in and run this helper again; no Learning assignment was saved.",
    );
  }
  const get = await run(
    ["learning", "containers", "get", "openbot", "--json"],
    directory,
  );
  if (containerMissing(json(get.stdout))) {
    const created = await run(
      [
        "learning",
        "containers",
        "create",
        "--id",
        "openbot",
        "--name",
        "OpenBot",
        "--json",
      ],
      directory,
    );
    verifiedContainer(created, projectId, "create");
  } else verifiedContainer(get, projectId, "get");

  const current = await readFile(envPath, "utf8");
  const provisioned = parseEnv(current);
  const currentProject = json(await readFile(projectPath, "utf8"));
  if (
    currentProject.projectId !== projectId ||
    provisioned[CONTAINER] ||
    provisioned.INTELLIGENCE_API_KEY
  ) {
    throw new Error(
      "Setup configuration changed while provisioning. It was preserved; inspect .env and run this helper again.",
    );
  }
  const key = provisioned.CPK_INTELLIGENCE_API_KEY?.trim();
  if (!key?.startsWith("cpk-")) {
    throw new Error(
      "The CLI did not write a runtime key. Run project select and this helper again.",
    );
  }
  const content = upsert(
    upsert(current, "INTELLIGENCE_API_KEY", key),
    CONTAINER,
    "openbot",
  );
  await saveEnvironment(envPath, content);
  return "configured";
}

const RESULT_MESSAGES: Record<
  Exclude<SetupLearningResult, "skipped">,
  string
> = {
  configured:
    "Configured the selected project's openbot Learning container and OpenBot runtime key in .env. Saved Admin settings still take precedence.",
  preserved: "Preserved the existing Learning container assignment.",
  present:
    "This runtime key's project has the openbot Learning container. OpenBot assigns it as the default on start unless Admin → Automatic Learning has a saved setting.",
  created:
    "Created the openbot Learning container in this runtime key's project. OpenBot assigns it as the default on start unless Admin → Automatic Learning has a saved setting.",
};

/** What to run instead, for the Intelligence this checkout points at. */
async function skippedMessage(directory: string) {
  const values = parseEnv(
    await readFile(resolve(directory, ".env"), "utf8").catch(() => ""),
  );
  let apiUrl = MANAGED_API;
  try {
    apiUrl = apiOrigin(
      (
        process.env.INTELLIGENCE_API_URL ||
        values.INTELLIGENCE_API_URL ||
        MANAGED_API
      ).trim(),
    );
  } catch {}
  return `Automatic Learning: no openbot container was created, because nothing here can create one without a person. ${learningSetupInstructions(apiUrl)}`;
}

if (import.meta.main) {
  const nonInteractive = process.argv.slice(2).includes("--non-interactive");
  try {
    const result = await setupLearning({
      nonInteractive,
      // A start script on a machine that never signed in should not download the CLI to find out.
      ...(nonInteractive ? { cliLogin: cliLoginPresent() } : {}),
    });
    console.log(
      result === "skipped"
        ? await skippedMessage(process.cwd())
        : RESULT_MESSAGES[result],
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Learning setup failed; no assignment was saved.";
    // Run by scripts/start.sh, a failure here must not stop OpenBot starting: say it and move on.
    if (nonInteractive) console.log(`Automatic Learning: ${message}`);
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}
