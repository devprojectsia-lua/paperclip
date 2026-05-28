import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const serviceTokens = pgTable(
  "service_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    tokenHash: text("token_hash").notNull().unique(),
    name: text("name").notNull(),
    scopes: text("scopes").array().notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => authUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    description: text("description"),
  },
  (table) => ({
    tokenHashIdx: index("service_tokens_token_hash_idx").on(table.tokenHash),
    companyIdx: index("service_tokens_company_idx").on(table.companyId),
  }),
);
