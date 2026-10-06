-- Existing feeds were made per project, with no record of who subscribed, so
-- there is nobody to check their access against. They are removed rather than
-- assigned to a guessed owner; each member recreates the feeds they want from
-- the project's calendar settings, and the new links read as them.
--
-- Locked first: during a rolling upgrade, an instance still on the old code
-- could insert another ownerless feed between the delete and the column
-- below, which would then fail its NOT NULL and keep this one from starting.
-- Held until the migration commits.
LOCK TABLE "calendar_feed" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DELETE FROM "calendar_feed";--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "calendar_feed_user_id_idx" ON "calendar_feed" USING btree ("user_id");