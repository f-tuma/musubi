CREATE TABLE "user_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"is_sponsor" boolean DEFAULT false,
	"is_premium" boolean DEFAULT false
);
--> statement-breakpoint
ALTER TABLE "user_status" ADD CONSTRAINT "user_status_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;