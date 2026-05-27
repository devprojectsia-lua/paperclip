import { pgTable, uuid, text, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentAlertState = pgTable(
  "agent_alert_state",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    alertKind: text("alert_kind").notNull(),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.alertKind], name: "agent_alert_state_pk" }),
    lastFiredAtIdx: index("agent_alert_state_last_fired_at_idx").on(table.lastFiredAt),
  }),
);
