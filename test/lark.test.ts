import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";

import { DeliveryError, makeSend } from "../src/lark";

describe("LarkSender", () => {
  it.effect("returns the confirmed message ID", () => {
    const send = makeSend(async (_post, deliveryId) => {
      expect(deliveryId).toBe("fake-delivery-id");
      return {
        code: 0,
        data: { message_id: "fake-message-id" },
      };
    });

    return send(
      { _tag: "Done", session: { project: "test-project", title: "Test" } },
      "fake-delivery-id",
    ).pipe(
      Effect.map((messageId) => {
        expect(messageId).toBe("fake-message-id");
      }),
    );
  });

  for (const { name, request, message } of [
    {
      name: "rejects request failures with a DeliveryError",
      request: async () => {
        throw new Error("fake-error");
      },
      message: "Lark request failed",
    },
    {
      name: "rejects API errors with a DeliveryError",
      request: async () => ({ code: 999 }),
      message: "Lark rejected the message (code 999)",
    },
    {
      name: "rejects missing message IDs with a DeliveryError",
      request: async () => ({ code: 0 }),
      message: "Lark returned no message ID",
    },
  ]) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const send = makeSend(request);
        const result = yield* Effect.exit(
          send(
            { _tag: "Done", session: { project: "test-project", title: "Test" } },
            "fake-delivery-id",
          ),
        );

        expect(Exit.isFailure(result)).toBe(true);

        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));

          expect(error).toBeInstanceOf(DeliveryError);
          expect(error?.message).toBe(message);
        }
      }),
    );
  }
});
