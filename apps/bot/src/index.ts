import { Worker } from "bullmq";
import { config } from "./config";
import { JOIN_QUEUE, redisConnection, type JoinJob } from "./queue";
import { linkSharedMeetings, removeDeletedJobs, scheduleDueMeetings } from "./scheduler";
import { summarizePending, summarizer } from "./summarize";
import { transcribePending, transcriptionProvider } from "./transcribe";
import { closeAllBrowsers } from "./meet/join";
import { runBotSession } from "./worker";

const SCHEDULE_EVERY_MS = 20_000;
const TRANSCRIBE_EVERY_MS = 30_000;

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
    await removeDeletedJobs();
    await linkSharedMeetings();
  } catch (err) {
    console.error("Scheduler failed:", err);
  }
  timer = setTimeout(tick, SCHEDULE_EVERY_MS);
}
void tick();

// After a call: transcribe the recording, then write AI notes from the transcript.
const provider = transcriptionProvider();
const notesWriter = summarizer();
let transcribeTimer: NodeJS.Timeout | undefined;
async function transcribeTick() {
  try {
    // A user's own Gemini key, saved in Settings, is used for their calls.
    if (provider) await transcribePending((geminiKey) => transcriptionProvider(geminiKey) ?? provider);
    if (notesWriter) await summarizePending((geminiKey) => summarizer(geminiKey) ?? notesWriter);
  } catch (err) {
    console.error("Post-call processing failed:", err);
  }
  transcribeTimer = setTimeout(transcribeTick, TRANSCRIBE_EVERY_MS);
}
if (provider || notesWriter) void transcribeTick();

console.log(
  `Bot worker started (concurrency ${config.BOT_CONCURRENCY}; transcription: ${provider?.name ?? "off, no DEEPGRAM_API_KEY"}; notes: ${notesWriter?.name ?? "off, no GEMINI_API_KEY or GROQ_API_KEY"})`,
);

async function shutdown() {
  clearTimeout(timer);
  clearTimeout(transcribeTimer);
  // Recordings can run for hours; end them now so each session saves its audio before we exit.
  const closing = worker.close();
  await closeAllBrowsers();
  await closing;
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
