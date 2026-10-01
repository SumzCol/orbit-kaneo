import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { WSContext } from "hono/ws";
import db from "../database";
import { projectTable } from "../database/schema";
import { subscribeToEvent } from "../events";
import { isRedisConfigured } from "../redis";
import {
  getRelationSourceProject,
  getSubtaskParentProjects,
} from "../task/get-subtask-parent-projects";
import type {
  BroadcastAdapter,
  BroadcastMessage,
  ProjectBroadcastMessage,
  UserBroadcast,
  UserBroadcastMessage,
} from "./broadcast-adapter";
import { userCanAccessProject } from "../utils/project-access";
import { InMemoryBroadcastAdapter } from "./in-memory-broadcast-adapter";
import { RedisBroadcastAdapter } from "./redis-broadcast-adapter";

const INSTANCE_ID = randomUUID();

/**
 * Control message rather than a client notification: it never reaches a
 * socket, it closes one. Access is checked once at upgrade time, so without it
 * a removed member keeps receiving a project's events until they reconnect.
 */
const PROJECT_ACCESS_REVOKED = "PROJECT_ACCESS_REVOKED";

// 4403 mirrors the HTTP status the reconnect attempt will get.
const ACCESS_REVOKED_CLOSE_CODE = 4403;

type ProjectConnection = {
  ws: WSContext;
  userId: string;
  initiatorId: string;
  workspaceId: string;
};

type UserConnection = {
  ws: WSContext;
};

/**
 * User-scoped connections: tracks WebSocket connections keyed by userId.
 * Used for delivering user-targeted events like NOTIFICATION_CREATED.
 */
const userConnections = new Map<string, Set<UserConnection>>();

export function addUserConnection(userId: string, ws: WSContext) {
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  const conn: UserConnection = { ws };
  userConnections.get(userId)?.add(conn);
  return conn;
}

export function removeUserConnection(userId: string, conn: UserConnection) {
  const connections = userConnections.get(userId);
  if (connections) {
    connections.delete(conn);
    if (connections.size === 0) {
      userConnections.delete(userId);
    }
  }
}

export function broadcastToUser(userId: string, message: UserBroadcastMessage) {
  deliverToLocalUserConnections(userId, message);

  if (!adapter) {
    return;
  }

  void adapter
    .publishToUser({ userId, message, origin: INSTANCE_ID })
    .catch((err) => {
      console.error("Failed to publish a user broadcast:", err);
    });
}

/**
 * Tells every session a user has open, not only a board on this project, that
 * their access to it changed. The project socket only reaches someone who has
 * that board open; the sidebar in every other tab keeps listing the project
 * (or keeps not listing it) until something unrelated refetches.
 */
export function notifyProjectAccessChanged(
  userId: string,
  projectId: string,
  hasAccess: boolean,
) {
  broadcastToUser(userId, {
    type: "PROJECT_ACCESS_CHANGED",
    projectId,
    hasAccess,
  });
}

function deliverToLocalUserConnections(
  userId: string,
  message: UserBroadcastMessage,
) {
  const connections = userConnections.get(userId);
  if (!connections) return;

  const payload = JSON.stringify(message);
  for (const conn of connections) {
    try {
      conn.ws.send(payload);
    } catch {
      connections.delete(conn);
    }
  }
  if (connections.size === 0) {
    userConnections.delete(userId);
  }
}

/**
 * Local connections: each instance tracks only its own WebSocket connections.
 */
const projectConnections = new Map<string, Set<ProjectConnection>>();

/**
 * Batching queues and timers local per-instance.
 * They accumulate messages before flushing to the broadcast adapter.
 */
const projectBroadcastQueues = new Map<
  string,
  Map<string, { message: ProjectBroadcastMessage; excludeInitiatorId?: string }>
>();
const projectBroadcastTimeouts = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

let adapter: BroadcastAdapter | null = null;

// --- Subscribe to incoming broadcasts and deliver to local connections ---
export async function initializeWebSocketAdapter() {
  if (adapter) return;

  const nextAdapter = isRedisConfigured()
    ? new RedisBroadcastAdapter()
    : new InMemoryBroadcastAdapter();

  try {
    await nextAdapter.subscribe((msg: BroadcastMessage) => {
      if (msg.message.type === PROJECT_ACCESS_REVOKED) {
        const revokedUserId = msg.message.userId;
        if (revokedUserId) {
          // The publish is asynchronous, so this can arrive after the user has
          // been added back. The client treats 4403 as permanent and purges
          // its caches on it, so a late message would cost a reconnected user
          // their board. Asked again before acting, failing open on a lookup
          // error the way the sweep does.
          closeIfStillRevoked(msg.projectId, revokedUserId);
        }
        return;
      }
      return deliverToLocalConnections(
        msg.projectId,
        msg.message,
        msg.excludeInitiatorId,
      );
    });
    await nextAdapter.subscribeToUser((msg: UserBroadcast) => {
      if (msg.origin === INSTANCE_ID) {
        return;
      }
      deliverToLocalUserConnections(msg.userId, msg.message);
    });
  } catch (err) {
    await nextAdapter.shutdown().catch(() => {});
    throw err;
  }

  adapter = nextAdapter;
  if (accessSweep === null) {
    accessSweep = setInterval(() => {
      void sweepRevokedConnections();
    }, ACCESS_SWEEP_MS);
    accessSweep.unref?.();
  }
  console.log(`📡 WebSockets Initialized using: "${adapter.constructor.name}"`);
}

export async function shutdownWebSocketAdapter() {
  if (accessSweep !== null) {
    clearInterval(accessSweep);
    accessSweep = null;
  }
  const pendingQueues = [...projectBroadcastQueues.entries()];

  for (const timeout of projectBroadcastTimeouts.values()) {
    clearTimeout(timeout);
  }
  projectBroadcastTimeouts.clear();
  projectBroadcastQueues.clear();

  const currentAdapter = adapter;
  if (currentAdapter) {
    await Promise.allSettled(
      pendingQueues.flatMap(([projectId, queue]) =>
        [...queue.values()].map(({ message, excludeInitiatorId }) =>
          currentAdapter.publish({ projectId, message, excludeInitiatorId }),
        ),
      ),
    );
  }

  await currentAdapter?.shutdown();
  adapter = null;
}

function closeLocalProjectConnections(
  projectId: string,
  revokedUserIds: string[] = [],
) {
  const timeout = projectBroadcastTimeouts.get(projectId);
  if (timeout) clearTimeout(timeout);
  projectBroadcastTimeouts.delete(projectId);
  projectBroadcastQueues.delete(projectId);
  const connections = projectConnections.get(projectId);
  projectConnections.delete(projectId);
  // Whoever lost access in this move needs the permanent code, and it has to
  // be decided here rather than by a second message: the two would race, and
  // on a peer the move close would usually win.
  const revoked = new Set(revokedUserIds);
  for (const conn of connections ?? []) {
    const lostAccess = revoked.has(conn.userId);
    if (!lostAccess) {
      try {
        conn.ws.send(JSON.stringify({ type: "PROJECT_MOVED", projectId }));
      } catch {
        /* The socket may already be closed. */
      }
    }
    try {
      if (lostAccess) {
        conn.ws.close(ACCESS_REVOKED_CLOSE_CODE, "Project access revoked");
      } else {
        conn.ws.close(1008, "Project workspace changed");
      }
    } catch {
      /* Already closed. */
    }
  }
}

export async function closeProjectConnections(
  projectId: string,
  revokedUserIds: string[] = [],
) {
  closeLocalProjectConnections(projectId, revokedUserIds);
  try {
    await adapter?.publish({
      projectId,
      message: { type: "PROJECT_MOVED", projectId, revokedUserIds },
    });
  } catch (error) {
    // Delivery also checks the workspace, so missed Redis notifications cannot
    // leave old connections receiving future project updates.
    console.error("Failed to publish project move:", error);
  }
}

const workspaceLookups = new Map<string, Promise<string | null>>();
function currentProjectWorkspace(projectId: string) {
  let pending = workspaceLookups.get(projectId);
  if (!pending) {
    pending = db
      .select({ workspaceId: projectTable.workspaceId })
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .limit(1)
      .then(([project]) => project?.workspaceId ?? null)
      .finally(() => workspaceLookups.delete(projectId));
    workspaceLookups.set(projectId, pending);
  }
  return pending;
}

// A connection is authorized once, at upgrade. A revocation reaches other
// instances as a control message, and a control message can be lost: the
// publish is best-effort and Redis can be down for it. This sweep is the
// backstop, so a lost message costs at most one interval of access rather
// than the lifetime of an open board. It is deliberately not on the delivery
// path, which must not grow a database read per message.
const ACCESS_SWEEP_MS = 30_000;
let accessSweep: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

export async function sweepRevokedConnections() {
  // One sweep walks every connected project and user sequentially, so a slow
  // database or enough open boards can outlast the interval. Overlapping runs
  // would multiply that load rather than catch up, so a tick that arrives
  // while one is still going is dropped.
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    await runRevocationSweep();
  } finally {
    sweepInFlight = false;
  }
}

async function runRevocationSweep() {
  for (const [projectId, connections] of [...projectConnections.entries()]) {
    const userIds = new Set([...connections].map((conn) => conn.userId));
    for (const userId of userIds) {
      let allowed: boolean;
      try {
        allowed = await userCanAccessProject(projectId, userId);
      } catch (error) {
        // A failed lookup is not evidence of revocation; leave the connection
        // for the next sweep rather than disconnecting on a blip.
        console.error(
          `Failed to revalidate project ${projectId} access:`,
          error,
        );
        continue;
      }
      if (!allowed) closeLocalProjectConnectionsForUser(projectId, userId);
    }
  }
}

async function deliverToLocalConnections(
  projectId: string,
  message: ProjectBroadcastMessage,
  excludeInitiatorId?: string,
) {
  if (message.type === "PROJECT_MOVED") {
    // The list is the sender's answer at the time of the move. A peer can
    // process the message after one of those users was added back, and the
    // permanent code would then end a session they are entitled to: the
    // client stops reconnecting and drops the project. So each id is asked
    // again here, and only the ones still without access get 4403. A lookup
    // that fails is not evidence of revocation, so that user gets the move's
    // ordinary close instead.
    const stillRevoked: string[] = [];
    for (const userId of message.revokedUserIds ?? []) {
      try {
        if (!(await userCanAccessProject(projectId, userId))) {
          stillRevoked.push(userId);
        }
      } catch (error) {
        console.error(
          `Failed to revalidate a moved project's revocation for ${projectId}:`,
          error,
        );
      }
    }
    closeLocalProjectConnections(projectId, stillRevoked);
    return;
  }
  const connections = projectConnections.get(projectId);
  if (!connections) return;
  const recipients = [...connections];
  let workspaceId: string | null;
  try {
    workspaceId = await currentProjectWorkspace(projectId);
  } catch (error) {
    console.error("Failed to validate project broadcast access:", error);
    workspaceId = null;
  }
  const payload = JSON.stringify(message);
  for (const conn of recipients) {
    // A move may have closed these connections while the lookup was in flight.
    if (!projectConnections.get(projectId)?.has(conn)) continue;
    if (conn.workspaceId !== workspaceId) {
      removeConnection(projectId, conn);
      try {
        conn.ws.close(1008, "Project workspace changed");
      } catch {
        /* Already closed. */
      }
      continue;
    }
    if (excludeInitiatorId && conn.initiatorId === excludeInitiatorId) continue;
    try {
      conn.ws.send(payload);
    } catch {
      removeConnection(projectId, conn);
    }
  }
}

function closeLocalProjectConnectionsForUser(
  projectId: string,
  userId: string,
) {
  const connections = projectConnections.get(projectId);
  if (!connections) return;

  for (const conn of connections) {
    if (conn.userId !== userId) continue;
    try {
      conn.ws.close(ACCESS_REVOKED_CLOSE_CODE, "Project access revoked");
    } catch {
      // Already gone; dropping it reaches the same end state.
    }
    connections.delete(conn);
  }

  if (connections.size === 0) {
    projectConnections.delete(projectId);
  }
}

/**
 * Drops a user's live connections to a project on every instance, for when
 * their access to it is taken away.
 */
/**
 * Closes a user's local connections to a project with 4403, but only if they
 * still lack access when it runs.
 *
 * The caller decided on a revocation from a lookup made after its change
 * committed, and an add can commit in between. A 4403 is permanent on the
 * client, so acting on the stale answer would end a session the user is now
 * entitled to. A failed lookup leaves the connection to the sweep.
 */
function closeIfStillRevoked(projectId: string, userId: string) {
  void userCanAccessProject(projectId, userId)
    .then((allowed) => {
      if (!allowed) closeLocalProjectConnectionsForUser(projectId, userId);
    })
    .catch((error) => {
      console.error(
        `Failed to revalidate a revocation for project ${projectId}:`,
        error,
      );
    });
}

export function revokeProjectAccess(projectId: string, userId: string) {
  // Asked again here as well as on every peer: the delay between the
  // caller's lookup and this close is where a concurrent add lands.
  closeIfStillRevoked(projectId, userId);

  if (!adapter) {
    return;
  }

  // Published straight through rather than queued: the batching queue's dedup
  // key does not include the user, so two revocations in the same window would
  // collapse into one.
  void adapter
    .publish({
      projectId,
      message: { type: PROJECT_ACCESS_REVOKED, projectId, userId },
    })
    .catch((err) => {
      console.error(
        `Failed to publish an access revocation for project ${projectId}:`,
        err,
      );
    });
}

export function addConnection(
  projectId: string,
  ws: WSContext,
  userId: string,
  initiatorId: string,
  workspaceId: string,
) {
  if (!projectConnections.has(projectId)) {
    projectConnections.set(projectId, new Set());
  }
  const conn: ProjectConnection = { ws, userId, initiatorId, workspaceId };
  projectConnections.get(projectId)?.add(conn);
  return conn;
}

export function removeConnection(projectId: string, conn: ProjectConnection) {
  const connections = projectConnections.get(projectId);
  if (connections) {
    connections.delete(conn);
    if (connections.size === 0) {
      projectConnections.delete(projectId);
    }
  }
}

export function broadcastToProject(
  projectId: string,
  message: ProjectBroadcastMessage,
  excludeInitiatorId?: string,
) {
  if (!adapter) {
    console.warn("broadcastToProject called before adapter initialization");
    return;
  }

  if (!projectBroadcastQueues.has(projectId)) {
    projectBroadcastQueues.set(projectId, new Map());
  }

  const messageKey = `${message.type === "TASKS_REORDERED" ? `${message.type}:${crypto.randomUUID()}` : message.type}:${message.taskId ?? ""}:${message.sourceTaskId ?? ""}:${message.targetTaskId ?? ""}`;
  projectBroadcastQueues
    .get(projectId)
    ?.set(messageKey, { message, excludeInitiatorId });

  if (projectBroadcastTimeouts.has(projectId)) {
    return;
  }

  const timeout = setTimeout(() => {
    projectBroadcastTimeouts.delete(projectId);
    const queue = projectBroadcastQueues.get(projectId);
    projectBroadcastQueues.delete(projectId);

    if (!queue || !adapter) return;

    // Publish each queued message through the adapter
    for (const { message: msg, excludeInitiatorId: exId } of queue.values()) {
      void adapter
        .publish({
          projectId,
          message: msg,
          excludeInitiatorId: exId,
        })
        .catch((err) => {
          console.error(
            `Failed to publish broadcast for project ${projectId}:`,
            err,
          );
        });
    }
  }, 100);

  projectBroadcastTimeouts.set(projectId, timeout);
}

type TaskEvent = {
  skipSubtaskParentRefresh?: boolean;
  id: string | undefined;
  projectId: string;
  userId: string;
  initiatorId?: string;
  taskId: string;
  sourceTaskId: string | undefined;
  targetTaskId: string | undefined;
};

// Include the initiating window: its local mutation refreshes the child project,
// while it may be displaying a different parent board. Never send child data.
function refreshParentBoards(
  projects: { projectId: string }[],
  currentProjectId = "",
) {
  for (const { projectId } of projects) {
    if (projectId === currentProjectId) continue;
    broadcastToProject(projectId, {
      type: "TASK_RELATION_UPDATED",
      projectId,
      taskId: "",
    });
  }
}

subscribeToEvent<{ projects: { projectId: string }[] }>(
  "subtask-parents.refresh",
  async ({ projects }) => {
    refreshParentBoards(projects);
  },
);

const taskUpdateEvents = [
  "task.created",
  "task.updated",
  "task.deleted",
  "task.status_changed",
  "task.priority_changed",
  "task.unassigned",
  "task.assignee_changed",
  "task.due_date_changed",
  "task.title_changed",
  "task.description_changed",
  "task.label_assigned",
  "task.label_unassigned",
  "task.label_created",
  "task.labels_updated",
  "task.label_deleted",
  "task-relation.created",
  "task-relation.deleted",
  "comment.created",
  "comment.deleted",
  "comment.updated",
];

subscribeToEvent<{
  taskId: string;
  userId: string;
  initiatorId?: string;
  type: string;
  content: string;
  fromProjectId: string;
  fromProjectName: string;
  toProjectId: string;
  toProjectName: string;
  oldStatus: string;
  newStatus: string;
}>("task.moved", async (data) => {
  const { fromProjectId, initiatorId, toProjectId, taskId } = data;

  broadcastToProject(
    toProjectId,
    { type: "TASK_MOVED", projectId: toProjectId, taskId },
    initiatorId,
  );
  broadcastToProject(
    fromProjectId,
    { type: "TASK_MOVED", projectId: fromProjectId, taskId },
    initiatorId,
  );
  refreshParentBoards(await getSubtaskParentProjects([taskId]), toProjectId);
});

subscribeToEvent<{
  projectId: string;
  userId: string;
  initiatorId?: string;
}>("task-relation.refresh", async (data) => {
  const { projectId, initiatorId } = data;
  if (!projectId) return;

  broadcastToProject(
    projectId,
    {
      type: "TASK_RELATION_UPDATED",
      projectId,
      taskId: "",
      sourceTaskId: undefined,
      targetTaskId: undefined,
    },
    initiatorId,
  );
});

// Project-scoped rather than per task: a project move can unassign every task
// in the project at once, so clients refetch the board once instead of
// receiving one message per task.
subscribeToEvent<{
  projectId: string;
  userId: string;
  initiatorId?: string;
}>("task.bulk_unassigned", async (data) => {
  const { projectId, initiatorId } = data;
  if (!projectId) return;

  broadcastToProject(
    projectId,
    { type: "TASK_UPDATED", projectId, taskId: "" },
    initiatorId,
  );
});

subscribeToEvent<{ notificationId: string; userId: string }>(
  "notification.created",
  async (data) => {
    if (data.userId) {
      broadcastToUser(data.userId, { type: "NOTIFICATION_CREATED" });
    }
  },
);

subscribeToEvent<{
  projectId: string;
  initiatorId?: string;
}>("project.updated", async (data) => {
  const { projectId, initiatorId } = data;
  if (!projectId) return;

  broadcastToProject(
    projectId,
    { type: "PROJECT_UPDATED", projectId },
    initiatorId,
  );
});

for (const eventName of taskUpdateEvents) {
  subscribeToEvent<TaskEvent>(eventName, async (data) => {
    const { projectId, initiatorId } = data;
    const taskId = data.taskId;

    if (!projectId || !taskId) return;
    let type: string;
    switch (eventName) {
      case "task.created":
        type = "TASK_CREATED";
        break;
      case "task.deleted":
        type = "TASK_DELETED";
        break;
      case "task-relation.created":
      case "task-relation.deleted":
        type = "TASK_RELATION_UPDATED";
        break;
      case "task.label_assigned":
      case "task.label_unassigned":
      case "task.label_created":
      case "task.labels_updated":
      case "task.label_deleted":
        type = "TASK_LABEL_UPDATED";
        break;
      case "comment.created":
      case "comment.deleted":
      case "comment.updated":
        type = "COMMENT_UPDATED";
        break;
      default:
        type = "TASK_UPDATED";
    }

    if (eventName === "task.label_deleted") {
      // Cascade deletion waits for this adapter operation rather than growing
      // the ordinary 100ms broadcast queue behind a slow Redis connection.
      await adapter?.publish({
        projectId,
        message: { type, projectId, taskId },
        excludeInitiatorId: initiatorId,
      });
      return;
    }

    broadcastToProject(
      projectId,
      {
        type,
        projectId,
        taskId: taskId,
        sourceTaskId: data.sourceTaskId,
        targetTaskId: data.targetTaskId,
      },
      initiatorId,
    );
    if (eventName === "task.status_changed" && !data.skipSubtaskParentRefresh) {
      refreshParentBoards(await getSubtaskParentProjects([taskId]), projectId);
    } else if (eventName === "task-relation.deleted" && data.sourceTaskId) {
      refreshParentBoards(
        await getRelationSourceProject(data.sourceTaskId),
        projectId,
      );
    }
  });
}

subscribeToEvent<{
  projectId: string;
  userId: string;
  tasks: Array<{ id: string; position: number; status?: string }>;
}>("tasks.reordered", async (data) => {
  broadcastToProject(data.projectId, {
    type: "TASKS_REORDERED",
    projectId: data.projectId,
    tasks: data.tasks,
  });
});
