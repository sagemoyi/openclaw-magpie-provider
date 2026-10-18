import { PROVIDER } from "./catalog.js";

/** All catalog writes and locking stay in the host. Never write openclaw.json. */
export async function materializeCatalog(config, snapshot, runtime, ctx = {}) {
  if (snapshot.stale) return { synced: false, reason: "stale" };
  if (typeof runtime.loadPreparedModelCatalog !== "function") {
    throw new Error("This plugin targets OpenClaw 2026.10.3. Older hosts are not supported.");
  }
  // Refresh the published inventory on its real lifecycle owner.
  // Do not create a synthetic config generation in the atomic runtime.
  const rows = await runtime.loadPreparedModelCatalog({
    config,
    readOnly: false,
    refreshFullCatalog: true,
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
    ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
  });
  const published = new Set(rows.filter((row) => row.provider === PROVIDER).map((row) => row.id));
  if (snapshot.models.some((model) => !published.has(model.id))) {
    throw new Error("OpenClaw did not publish the complete Magpie catalog; sync will retry");
  }
  const allowed = new Set([
    ...snapshot.models,
    ...(config.models?.providers?.[PROVIDER]?.models ?? []),
  ].map((model) => model.id));
  if ([...published].some((id) => !allowed.has(id))) {
    throw new Error("OpenClaw retained removed Magpie models; sync will retry");
  }
  return { synced: true, models: snapshot.models.length, revision: snapshot.revision, mode: "prepared" };
}
