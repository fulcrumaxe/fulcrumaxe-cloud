// Spawned by ephemeral-pg-cleanup.test.ts: provisions a cluster per module
// instance (LEAK_INSTANCES, default 1; each instance is a separate evaluation of
// ephemeral-pg.ts), reports READY, then idles until it is killed.
const instances = Number(process.env.LEAK_INSTANCES ?? 1);
for (let i = 0; i < instances; i++) {
  const mod = await import(`./ephemeral-pg.ts?instance=${i}`);
  await mod.provisionEphemeralPostgres({ database: `fx_leak_child${i}`, tmpPrefix: 'fx-leakchild-pg-' });
}
process.stdout.write('READY\n');
setInterval(() => {}, 1000);
