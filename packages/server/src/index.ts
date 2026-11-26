import { buildApp } from "./app.js";

async function main() {
  const { app, services } = await buildApp();
  await services.chain.getEffectiveNow();
  services.atlasOracle.start();
  services.rwaRisk.start();
  services.marketData.start();
  services.chain.start();

  // Keep cached effective time synced with latest EVM block timestamp
  setInterval(() => {
    void services.chain.getEffectiveNow();
  }, 2000).unref?.();

  await app.listen({
    port: services.config.port,
    host: services.config.host,
  });

  console.log(
    `Payoff BNB server listening at http://${services.config.host}:${services.config.port} (chainId=${services.config.chainId}, vault=${services.config.vaultAddress}, oracle=${services.config.settlementOracleAddress})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
