import { Rpc } from "@opencode/plugin/rpc";
import { Session } from "@opencode/schema";
import { Schema } from "effect";
import type { StandardSchemaV1 } from "effect/StandardSchema";

export const NotificationState = Schema.Struct({
  sessionID: Session.ID,
  enabled: Schema.Boolean,
});

export type NotificationState = typeof NotificationState.Type;

const notificationStateStandard: StandardSchemaV1<
  typeof NotificationState.Encoded,
  NotificationState
> = {
  "~standard": Schema.toStandardSchemaV1(NotificationState)["~standard"],
};

export const LarkPingRpc = Rpc.define({
  id: "lark-ping",
  methods: {},
  events: {
    changed: {
      schema: notificationStateStandard,
    },
  },
});
