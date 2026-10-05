import * as lark from "@larksuiteoapi/node-sdk";
import { Context, Effect, Layer, Redacted, Schema } from "effect";

import { PluginConfig } from "./config";
import { Notice } from "./notification";

const LarkPost = Schema.Struct({
  en_us: Schema.Struct({
    title: Schema.String,
    content: Schema.Array(
      Schema.Array(
        Schema.Struct({
          tag: Schema.Literal("text"),
          text: Schema.String,
          style: Schema.optional(Schema.Array(Schema.Literal("bold"))),
        }),
      ),
    ),
  }),
});

type LarkPost = typeof LarkPost.Type;

const formatNotice = (notice: Notice): LarkPost => ({
  en_us: {
    title: Notice.match(notice, {
      Done: () => "OpenCode · Finished",
      Blocked: () => "OpenCode · Needs attention",
    }),
    content: [
      [
        { tag: "text", text: "Project: ", style: ["bold"] },
        { tag: "text", text: notice.session.project },
      ],
      [
        { tag: "text", text: "Session: ", style: ["bold"] },
        { tag: "text", text: notice.session.title },
      ],
    ],
  },
});

export class DeliveryError extends Schema.TaggedError<DeliveryError>()("DeliveryError", {
  message: Schema.String,
}) {}

type MessageResponse = {
  readonly code?: number;
  readonly data?: {
    readonly message_id?: string;
  };
};

type CreateMessage = (post: LarkPost, deliveryId: string) => Promise<MessageResponse>;

export const makeSend = (createMessage: CreateMessage) =>
  Effect.fn("LarkSender.send")(function* (notice: Notice, deliveryId: string) {
    const response = yield* Effect.tryPromise({
      try: () => createMessage(formatNotice(notice), deliveryId),
      catch: () => new DeliveryError({ message: "Lark request failed" }),
    });

    if (response.code !== 0) {
      return yield* new DeliveryError({
        message: `Lark rejected the message (code ${response.code})`,
      });
    }

    const messageId = response.data?.message_id;

    if (!messageId) {
      return yield* new DeliveryError({
        message: "Lark returned no message ID",
      });
    }

    return messageId;
  });

export class LarkSender extends Context.Service<LarkSender>()("lark-ping/LarkSender", {
  make: Effect.gen(function* () {
    const config = yield* PluginConfig;

    const client = yield* Effect.sync(
      () =>
        new lark.Client({
          appId: config.credentials.appId,
          appSecret: Redacted.value(config.credentials.appSecret),
          domain: lark.Domain.Lark,
        }),
    );

    const send = makeSend((post, deliveryID) =>
      client.im.message.create({
        params: {
          receive_id_type: "open_id",
        },
        data: {
          receive_id: config.recipient.id,
          msg_type: "post",
          content: JSON.stringify(post),
          uuid: deliveryID,
        },
      }),
    );

    return { send };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
