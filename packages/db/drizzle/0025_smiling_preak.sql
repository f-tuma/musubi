CREATE TABLE "musubi_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"server" text NOT NULL,
	"remote_user_id" text NOT NULL,
	"encrypted_token" text NOT NULL,
	CONSTRAINT "musubi_accounts_user_id_server_unique" UNIQUE("user_id","server")
);
--> statement-breakpoint
ALTER TABLE "musubi_accounts" ADD CONSTRAINT "musubi_accounts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;