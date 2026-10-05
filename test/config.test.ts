import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Redacted, Schema } from "effect";

import { PluginConfig } from "../src/config";

describe("PluginConfig", () => {
  it.effect("provides validated configuration", () =>
    Effect.gen(function* () {
      const config = yield* PluginConfig;

      expect(config.recipient.id).toBe("ou_test");
      expect(config.credentials.appId).toBe("cli_test");
      expect(Redacted.value(config.credentials.appSecret)).toBe("fake-secret");
      expect(JSON.stringify(config.credentials.appSecret)).not.toContain("fake-secret");
    }).pipe(
      Effect.provide(
        PluginConfig.layer({
          recipient: { id: "ou_test" },
          credentials: {
            appId: "cli_test",
            appSecret: "fake-secret",
          },
        }),
      ),
    ),
  );

  it.effect("rejects an empty app secret", () =>
    Effect.gen(function* () {
      const operation = Effect.service(PluginConfig).pipe(
        Effect.provide(
          PluginConfig.layer({
            recipient: { id: "ou_test" },
            credentials: {
              appId: "cli_test",
              appSecret: "",
            },
          }),
        ),
      );

      const result = yield* Effect.exit(operation);

      expect(Exit.isFailure(result)).toBe(true);

      if (Exit.isFailure(result)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));

        expect(Schema.isSchemaError(error)).toBe(true);
      }
    }),
  );
});
