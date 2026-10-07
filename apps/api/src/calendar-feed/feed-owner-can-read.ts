import { and, type SQLWrapper, sql } from "drizzle-orm";
import db, { schema } from "../database";
import { projectAccessCondition } from "../project-access/project-access-condition";
import { notBannedCondition } from "../utils/user-ban";

/**
 * Whether a feed's owner may still read its project: not banned, since a feed
 * link is the one way in that a ban's revoked sessions and API keys do not
 * cover, and reaching the project as a request would. The project access rule
 * leaves workspace membership to the route middleware, so it is asked here.
 */
export function feedOwnerCanRead(
  userId: string | SQLWrapper,
  projectId: string | SQLWrapper,
) {
  return sql<boolean>`(
    EXISTS (
      SELECT 1 FROM "user"
      WHERE ${and(sql`"user"."id" = ${userId}`, notBannedCondition())}
        AND (
          'admin' = ANY(string_to_array("user"."role", ','))
          OR EXISTS (
            SELECT 1 FROM project AS feed_project
            JOIN workspace_member AS feed_member
              ON feed_member.workspace_id = feed_project.workspace_id
              AND feed_member.user_id = ${userId}
            WHERE feed_project.id = ${projectId}
          )
        )
    )
    AND ${projectAccessCondition(userId, projectId)}
  )`;
}

export async function ownerCanReadFeed(
  projectId: string,
  userId: string,
  database: Pick<typeof db, "execute"> = db,
) {
  const result = await database.execute<{ allowed: boolean }>(
    sql`SELECT ${feedOwnerCanRead(userId, projectId)} AS allowed`,
  );
  return result.rows[0]?.allowed === true;
}

// The feed row's own columns, for conditions inside a statement on the table.
export const feedOwner = sql`${schema.calendarFeedTable}.user_id`;
export const feedProject = sql`${schema.calendarFeedTable}.project_id`;
