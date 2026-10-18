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
      const snapshot = await discover(ctx, { force });
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
 * The plugin owns this timer: OpenClaw's service scheduler is optional and its
 * job semantics differ between in-process hosts, while a timer has exactly the
 * service's lifetime and is joined by stop().
 */
export function createCatalogService({ sync, intervalMs, schedule = setTimeout, cancel = clearTimeout }) {
  let generation = 0;
  let active = false;
  let timer;
  let pending = Promise.resolve();
  const debug = (ctx, message) => {
    if (process.env.MAGPIE_DEBUG === "1") ctx.logger?.warn?.(`[magpie] ${message}`);
  };
  return {
    id: "magpie-catalog",
    async start(ctx) {
      if (active) return;
      active = true;
      const mine = ++generation;
      debug(ctx, `catalog service started; interval=${intervalMs}ms`);
      const tick = () => {
        if (!active || mine !== generation) return Promise.resolve();
        pending = Promise.resolve()
          .then(async () => {
            const result = await sync(ctx);
            debug(ctx, `catalog sync ${JSON.stringify(result)}`);
            return result;
          })
          .catch((error) => {
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
      await pending;
    },
  };
}
