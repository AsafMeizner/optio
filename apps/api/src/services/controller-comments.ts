import { and, eq } from "drizzle-orm";
import type { ControllerPrincipal } from "./controller-auth.js";
import { ControllerError, requireChange } from "./controller-access.js";
import { getControllerWork } from "./controller-service.js";
import { db } from "../db/client.js";
import { taskComments, taskEvents } from "../db/schema.js";
import * as comments from "./comment-service.js";

async function task(p: ControllerPrincipal, id: string, write = false) {
  const work = await getControllerWork(p, id);
  if (work.kind !== "run" || work.data.kind !== "repo")
    throw new ControllerError(400, "Comments and activity require a task run id");
  if (write) requireChange(p, work.data);
}
export async function controllerActivity(
  p: ControllerPrincipal,
  id: string,
  source: "comments" | "events",
  limit: number,
  offset: number,
) {
  await task(p, id);
  const rows =
    source === "comments"
      ? await db
          .select()
          .from(taskComments)
          .where(eq(taskComments.taskId, id))
          .orderBy(taskComments.createdAt, taskComments.id)
          .limit(limit + 1)
          .offset(offset)
      : await db
          .select()
          .from(taskEvents)
          .where(eq(taskEvents.taskId, id))
          .orderBy(taskEvents.createdAt, taskEvents.id)
          .limit(limit + 1)
          .offset(offset);
  return {
    source,
    entries: rows.slice(0, limit),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}
export async function writeControllerComment(
  p: ControllerPrincipal,
  id: string,
  action: "add" | "edit" | "delete",
  content?: string,
  commentId?: string,
) {
  await task(p, id, true);
  if (action !== "delete" && !content?.trim())
    throw new ControllerError(400, "A comment needs content");
  if (action === "add")
    return { comment: await comments.addComment(id, content!, p.actor.userId ?? undefined) };
  if (!commentId) throw new ControllerError(400, "A comment id is required");
  const [existing] = await db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.id, commentId), eq(taskComments.taskId, id)));
  if (!existing) throw new ControllerError(404, "Comment not found");
  if (existing.userId !== p.actor.userId)
    throw new ControllerError(403, "Only the author may change this comment");
  if (action === "edit")
    return {
      comment: await comments.updateComment(commentId, content!, p.actor.userId ?? undefined),
    };
  await comments.deleteComment(commentId, p.actor.userId ?? undefined);
  return { commentId, deleted: true };
}
