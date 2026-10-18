import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config";

export const JOIN_QUEUE = "bot-join";

export type JoinJob = { botSessionId: string; meetingId?: string };

export function redisConnection() {
  // BullMQ workers need maxRetriesPerRequest: null.
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

export const joinQueue = new Queue<JoinJob>(JOIN_QUEUE, { connection: redisConnection() });

// BullMQ runs lower numbers first. Calls someone sent the bot to right now go ahead of calendar calls.
export const PRIORITY_SENT_NOW = 1;
export const PRIORITY_CALENDAR = 10;

/** Whether a call someone sent the bot to right now is waiting for a free bot. */
export async function sentNowCallWaiting() {
  const jobs = await joinQueue.getJobs(["prioritized", "waiting"]);
  return jobs.some((j) => j?.opts.priority === PRIORITY_SENT_NOW);
}
