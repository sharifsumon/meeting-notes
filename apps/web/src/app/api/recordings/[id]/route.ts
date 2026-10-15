import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { botSessions, meetings } from "@minuteflow/db";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { env } from "@/env";
import { db } from "@/lib/db";

/** Streams a bot session's recording to its owner. Supports Range so the player can seek. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return new Response("Not signed in", { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });

  const [row] = await db()
    .select({ key: botSessions.recordingKey, title: meetings.title })
    .from(botSessions)
    .innerJoin(meetings, eq(botSessions.meetingId, meetings.id))
    .where(and(eq(botSessions.id, id), eq(meetings.userId, userId)))
    .limit(1);
  if (!row?.key) return new Response("Not found", { status: 404 });

  const root = path.resolve(env().STORAGE_DIR);
  const file = path.resolve(root, row.key);
  if (!file.startsWith(root + path.sep)) return new Response("Not found", { status: 404 });

  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (size === 0) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": "audio/webm",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  });
  if (new URL(req.url).searchParams.has("download")) {
    const name = `${row.title.replace(/[^\w .-]+/g, "").trim() || "recording"}.webm`;
    headers.set("Content-Disposition", `attachment; filename="${name}"`);
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start: number;
    let end: number;
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else {
      // "bytes=-N": the last N bytes.
      start = Math.max(size - Number(range[2]), 0);
      end = size - 1;
    }
    if (start > end || start >= size) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(toWeb(createReadStream(file, { start, end })), { status: 206, headers });
  }

  headers.set("Content-Length", String(size));
  return new Response(toWeb(createReadStream(file)), { headers });
}

function toWeb(stream: Readable) {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}
