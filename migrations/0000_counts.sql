-- drobek-module-counter: the named counters of an app (one row per app and key).
CREATE TABLE IF NOT EXISTS "mod_counter_counts" (
	"app_id" text NOT NULL,
	"key" text NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mod_counter_counts_app_id_key_pk" PRIMARY KEY("app_id","key"),
	CONSTRAINT "mod_counter_counts_count_check" CHECK ("count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mod_counter_counts" ADD CONSTRAINT "mod_counter_counts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
