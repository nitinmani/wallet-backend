import { config } from "./lib/config";
import app from "./app";
import { startScheduler } from "./cron/scheduler";

app.listen(config.port, () => {
  console.log(`Vencura API running on port ${config.port}`);
  startScheduler();
});

export default app;
