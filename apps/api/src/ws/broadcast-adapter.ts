export type ProjectBroadcastMessage = {
  type: string;
  projectId: string;
  taskId?: string;
  tasks?: Array<{ id: string; position: number; status?: string }>;
  sourceTaskId?: string;
  targetTaskId?: string;
  /** Only set on PROJECT_ACCESS_REVOKED: whose connections to close. */
  userId?: string;
  /**
   * Only set on PROJECT_MOVED: who lost access in the same move. They need the
   * revocation code rather than the move's, and sending it separately would
   * race the move close on every peer.
   */
  revokedUserIds?: string[];
};

export type BroadcastMessage = {
  projectId: string;
  message: ProjectBroadcastMessage;
  excludeInitiatorId?: string;
};

export type UserBroadcastMessage = {
  type: string;
  [key: string]: unknown;
};

export type UserBroadcast = {
  userId: string;
  message: UserBroadcastMessage;
  origin?: string;
};

export type BroadcastAdapter = {
  /** Publish a message to all instances watching this project */
  publish(msg: BroadcastMessage): Promise<void>;

  publishToUser(msg: UserBroadcast): Promise<void>;

  /** Subscribe to messages for delivery to local connections */
  subscribe(
    handler: (msg: BroadcastMessage) => void | Promise<void>,
  ): Promise<void>;

  subscribeToUser(handler: (msg: UserBroadcast) => void): Promise<void>;

  /** Cleanup on shutdown */
  shutdown(): Promise<void>;
};
