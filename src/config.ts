import { Context, Effect, Layer, Redacted, Schema } from "effect";

const LarkOpenID = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.brand("LarkOpenID"),
);

const LarkAppID = Schema.String.pipe(Schema.check(Schema.isNonEmpty()), Schema.brand("LarkAppID"));

const LarkAppSecret = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.brand("LarkAppSecret"),
);

const DurationMs = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("DurationMs"),
);

const recipient = Schema.Struct({ id: LarkOpenID });

const LarkCredentials = Schema.Struct({
  appId: LarkAppID,
  appSecret: LarkAppSecret,
});

const PluginOptions = Schema.Struct({
  recipient: recipient,
  credentials: LarkCredentials,
  minimumTurnDurationMs: Schema.optional(DurationMs),
});

export class PluginConfig extends Context.Service<PluginConfig>()("lark-ping/PluginConfig", {
  make: (options: unknown) =>
    Effect.gen(function* () {
      const validated = yield* Schema.decodeUnknownEffect(PluginOptions)(options);

      return {
        recipient: validated.recipient,
        credentials: {
          appId: validated.credentials.appId,
          appSecret: Redacted.make(validated.credentials.appSecret),
        },
        minimumTurnDurationMs: validated.minimumTurnDurationMs ?? DurationMs.make(0),
      } as const;
    }),
}) {
  static readonly layer = (options: unknown) => Layer.effect(this, this.make(options));
}
