import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { jsonb } from "./json";

/**
 * A saved Automatic Learning configuration.
 *
 * The shape lives here rather than in a shared module. The code that read and wrote these tables
 * went with the Intelligence Learning subsystem; the tables stay, because dropping one is a
 * migration rather than a refactor. Nothing in this deployment reads or writes a row.
 */
type LearningSettings = {
  enabled: boolean;
  defaultTarget: { containerId: string; revision?: string } | null;
  /** Missing inherits the default; null explicitly excludes this Bot. */
  agents: Record<string, { containerId: string; revision?: string } | null>;
};

/** Retained for migration history only: no code writes this table any more. */
export const learningSettings = pgTable("learning_settings", {
  id: text("id").primaryKey(),
  settings: jsonb("settings").$type<LearningSettings>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Retained for migration history only: no code writes this table any more. */
export const learningThreadBindings = pgTable(
  "learning_thread_bindings",
  {
    userId: text("user_id").notNull(),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    containerId: text("container_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.threadId] })],
);
