import { Worker } from "bullmq";
import { config } from "./config";
import { JOIN_QUEUE, redisConnection, type JoinJob } from "./queue";
import { scheduleDueMeetings } from "./scheduler";
import { runBotSession } from "./worker";

const SCHEDULE_EVERY_MS = 20_000;

const worker = new Worker<JoinJob>(JOIN_QUEUE, (job) => runBotSession(job.data.botSessionId), {
  connection: redisConnection(),
  concurrency: config.BOT_CONCURRENCY,
  // Recording a meeting takes as long as the meeting; renew the job lock meanwhile.
  lockDuration: 5 * 60_000,
});
worker.on("failed", (job, err) => console.error(`Job ${job?.id} failed:`, err));

let timer: NodeJS.Timeout | undefined;
async function tick() {
  try {
    await scheduleDueMeetings();
  } catch (err) {
    console.error("Scheduler failed:", err);
  }
  timer = setTimeout(tick, SCHEDULE_EVERY_MS);
}
void tick();
console.log(`Bot worker started (concurrency ${config.BOT_CONCURRENCY})`);

async function shutdown() {
  clearTimeout(timer);
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
