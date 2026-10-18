import { createHash } from "node:crypto";

/** Readable one-line detail for sync failures, including fetch-style causes. */
function describeError(error) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : "";
    return `${error.message}${cause}` || String(error);
  }
  return String(error);
}

/** Serialize discovery + publication, so an older write cannot finish last. */
export function createCatalogSynchronizer({ discover, publish, config }) {
  let tail = Promise.resolve();
  let publishedKey;
  return (ctx, force = false) => {
    const run = tail.then(async () => {
      ctx.signal?.throwIfAborted();
      const snapshot = await discover(ctx, { force });
      // A stopped service must not publish even if a resolver ignored cancellation.
      ctx.signal?.throwIfAborted();
      if (!snapshot) return { synced: false, reason: "unconfigured" };
      if (snapshot.stale) return { synced: false, reason: "stale" };
      const currentConfig = ctx.config ?? config;
      // Hash rather than retain serialized config: it may contain credentials.
      const key = createHash("sha256").update(JSON.stringify([
        snapshot.baseUrl,
        snapshot.revision,
        ctx.agentId,
        ctx.agentDir,
        ctx.workspaceDir,
        currentConfig,
      ])).digest("hex");
      if (!force && key === publishedKey) return { synced: false, reason: "unchanged" };
      const result = await publish(currentConfig, snapshot, ctx);
      if (result.synced) publishedKey = key;
      return result;
    });
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * Start the background loop without blocking host activation; stop drains it.
 * The plugin owns the timer, but each tick must enter a fresh host background
 * invocation and return the full sync promise. An inherited, already-released
 * start() token cannot participate safely in the host's plugin replacement drain.
 */
export function createCatalogService({ sync, intervalMs, runInBackgroundContext, schedule = setTimeout, cancel = clearTimeout }) {
  if (typeof runInBackgroundContext !== "function") {
    throw new Error("Magpie catalog service requires the host background lifecycle API");
  }
  let generation = 0;
  let active = false;
  let timer;
  let controller;
  let pending = Promise.resolve();
  const debug = (ctx, message) => {
    if (process.env.MAGPIE_DEBUG === "1") ctx.logger?.warn?.(`[magpie] ${message}`);
  };
  return {
    id: "magpie-catalog",
    // The host keeps service contexts immutable across config commits. Subscribe
    // to every config scope used by discovery/auth/publication, so restart gets
    // the committed config rather than retaining the startup endpoint or key.
    reload: { configPrefixes: ["models.providers.magpie", "auth", "agents", "secrets"] },
    async start(ctx) {
      if (active) return;
      active = true;
      controller = new AbortController();
      const signal = controller.signal;
      const mine = ++generation;
      debug(ctx, `catalog service started; interval=${intervalMs}ms`);
      const tick = () => {
        if (!active || mine !== generation) return Promise.resolve();
        pending = Promise.resolve()
          .then(async () => {
            signal.throwIfAborted();
            const result = await runInBackgroundContext(() => sync({ ...ctx, signal }));
            debug(ctx, `catalog sync ${JSON.stringify(result)}`);
            return result;
          })
          .catch((error) => {
            if (signal.aborted) return;
            ctx.logger?.warn?.(`Magpie catalog sync failed; retrying on the next interval: ${describeError(error)}`);
          })
          .finally(() => {
            if (active && mine === generation) {
              timer = schedule(tick, intervalMs);
              timer.unref?.();
            }
          });
        return pending;
      };
      // Prepared catalog publication may wait for this plugin generation to
      // become active. Awaiting it in start() makes replacement activation wait
      // on itself and can exceed the host's service startup deadline.
      //
      // A plugin-owned timer is used deliberately: it has the same lifetime as
      // this service and does not depend on the host scheduler's job semantics.
      void tick();
    },
    async stop() {
      active = false;
      generation++;
      cancel(timer);
      controller?.abort();
      // Cancel this service's discovery wait, not a shared fetch owned by other
      // consumers. A host publication already admitted must still be drained.
      await pending;
    },
  };
}
