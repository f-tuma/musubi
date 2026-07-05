CREATE TABLE "user_avatars" (
	"id" text PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL,
	"mime_type" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_id_user_id_fk" FOREIGN KEY ("id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;