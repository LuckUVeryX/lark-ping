import type { OpenCodeEvent } from "@opencode/client/effect";
import type { SessionMessage } from "@opencode/schema";
import { SessionID } from "@opencode/schema/session-id";
import { DateTime, Option, Schema } from "effect";

const SessionInfo = Schema.Struct({
  title: Schema.String,
  project: Schema.String,
});

export const Notice = Schema.TaggedUnion({
  Done: { session: SessionInfo },
  Blocked: { session: SessionInfo },
});

export type Notice = typeof Notice.Type;

export type NotificationIntent = {
  readonly kind: Notice["_tag"];
  readonly sessionID: SessionID;
};

export const notificationIntent = (event: OpenCodeEvent): Option.Option<NotificationIntent> => {
  switch (event.type) {
    case "session.execution.succeeded":
      return Option.some({
        kind: "Done",
        sessionID: event.data.sessionID,
      });
    case "session.execution.failed":
    case "permission.asked":
      return Option.some({
        kind: "Blocked",
        sessionID: event.data.sessionID,
      });

    case "form.created":
      const sessionID = event.data.form.sessionID;
      if (!Schema.is(SessionID)(sessionID)) {
        return Option.none();
      }
      return Option.some({
        kind: "Blocked",
        sessionID: sessionID,
      });

    default:
      return Option.none();
  }
};

export const turnDurationMs = (
  messages: readonly SessionMessage.Info[],
  completionMessageID: SessionMessage.ID,
): Option.Option<number> => {
  const completionIndex = messages.findIndex(
    (message) => message.id === completionMessageID && message.type === "idle",
  );
  if (completionIndex === -1) {
    return Option.none();
  }

  let firstPrompt: SessionMessage.User | SessionMessage.Synthetic | undefined;
  let completionTime: DateTime.Utc | undefined;

  for (const message of messages.slice(0, completionIndex).reverse()) {
    if (message.type === "idle") {
      break;
    }

    if (message.type === "compaction" && message.status === "completed") {
      return Option.none();
    }

    if (
      completionTime === undefined &&
      message.type === "assistant" &&
      message.time.completed !== undefined
    ) {
      completionTime = message.time.completed;
    }

    if (message.type === "user" || message.type === "synthetic") {
      firstPrompt = message;
    }
  }
  if (firstPrompt === undefined || completionTime === undefined) {
    return Option.none();
  }

  const duration =
    DateTime.toEpochMillis(completionTime) - DateTime.toEpochMillis(firstPrompt.time.created);

  return duration < 0 ? Option.none() : Option.some(duration);
};
