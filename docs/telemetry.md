# Telemetry

This fork sends no usage telemetry.

The upstream product's runtime reported its own events to `https://telemetry.copilotkit.ai/ingest`, and
the server added an `accessibility_title` to them. Both went with the vendor runtime: `server/src/telemetry.ts`
was deleted in the engine rewrite, and nothing in `openbot/server` or `openbot/app` carries an analytics
client or an ingest address today. That was checked, not assumed:

```sh
grep -rln "posthog\|segment\.io\|amplitude\|telemetry\.copilotkit\.ai" openbot/server openbot/app
```

## What still reads the switches

`OPENBOT_TELEMETRY_DISABLED=true` and `DO_NOT_TRACK=1` are still honoured where a component looks for
them, so a deployment that set them keeps the behaviour it asked for:

- `openbot/server/src/learning/ensure-container.ts` passes `OPENBOT_TELEMETRY_DISABLED=1` to the
  `npx` child it spawns, so the vendor CLI it runs never reports usage either.

## What this deployment does keep

Threads, messages, the event log and the run lock are rows in this deployment's own Postgres
(`openbot/server/src/db/schema/threads.ts`, migration `0068`, renamed in `0070`). No copy of them leaves
the deployment. Your model provider still receives every message it is asked to answer, as any model
provider does.
