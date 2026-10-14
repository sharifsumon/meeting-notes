import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

/** Appends audio chunks to a file under STORAGE_DIR. Returns the key relative to STORAGE_DIR. */
export async function openRecording(userId: string, botSessionId: string) {
  const key = path.posix.join(userId, `${botSessionId}.webm`);
  const file = path.join(config.STORAGE_DIR, key);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
  const handle: FileHandle = await open(file, "a", 0o640);
  let bytes = 0;
  return {
    key,
    get bytes() {
      return bytes;
    },
    async write(b64: string) {
      const buf = Buffer.from(b64, "base64");
      bytes += buf.length;
      await handle.write(buf);
    },
    close: () => handle.close(),
  };
}
