import type { Session } from "@opencode/schema";

export const notificationKey = (sessionID: Session.ID): string => `lark-ping-${sessionID}`;
