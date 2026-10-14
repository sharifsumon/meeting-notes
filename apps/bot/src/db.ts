import { createDb } from "@minuteflow/db";
import { config } from "./config";

export const db = createDb(config.DATABASE_URL);
