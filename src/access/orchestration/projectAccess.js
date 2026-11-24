// Which projects the actor may change (RF-USR-06): `project.write` says they may edit, and taking
// part says which ones. Shared by projects.js and finance.js, since the first imports the second.
import query from "../resources/query.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";

/**
 * Whether the actor takes part in a project: they created it or hold one of its stages. Members of
 * an area with a stage in it also do, and leaders of an area above one. Coordination always does.
 */
export async function takesPart(projectId) {
  const actor = currentActor();
  if (!actor) return false;
  return actor.role === "admin" || query.takesPartInProject(actor.id, projectId);
}

/** @throws {ApiError} 403 when the actor takes no part in the project. */
export async function requirePart(projectId) {
  if (!(await takesPart(projectId))) {
    throw ApiError.forbidden("Only someone taking part in this project changes it.");
  }
}

/** @throws {ApiError} 400 when `userId` is someone outside `areaId` (RF-TSK-01). */
export async function requireMember(userId, areaId) {
  if (userId === null) return;
  if (!(await query.isUserMemberOfArea(userId, areaId))) {
    throw ApiError.badRequest("The assignee must be a member of the stage's area.");
  }
}
