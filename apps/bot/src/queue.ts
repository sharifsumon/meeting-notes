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
