CREATE TABLE IF NOT EXISTS "agent_alert_state" (
	"agent_id" uuid NOT NULL,
	"alert_kind" text NOT NULL,
	"last_fired_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_alert_state_pk" PRIMARY KEY("agent_id","alert_kind")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_alert_state_last_fired_at_idx" ON "agent_alert_state" USING btree ("last_fired_at");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_alert_state" ADD CONSTRAINT "agent_alert_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
