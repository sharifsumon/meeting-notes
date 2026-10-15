/**
 * One-time sign-in for the bot's Google account.
 *
 * Starts Chrome with the bot profile and a DevTools port on 127.0.0.1:9222. From your
 * own computer, tunnel the port and drive the window from chrome://inspect:
 *
 *   ssh -L 9222:127.0.0.1:9222 root@your-server
 *   then open chrome://inspect in Chrome, add localhost:9222, and click "inspect"
 *
 * Sign in to Google in that window, then press Ctrl+C here.
 */
import { spawn } from "node:child_process";

const chrome = process.env.CHROME_PATH;
const profile = process.env.BOT_PROFILE_DIR;
if (!chrome || !profile) {
  console.error("Set CHROME_PATH and BOT_PROFILE_DIR");
  process.exit(1);
}

const child = spawn(
  chrome,
  [
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "--no-first-run",
    "--no-default-browser-check",
    "--lang=en-US",
    "https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/",
  ],
  { stdio: "inherit" },
);
console.log("Chrome is running with the bot profile. Sign in via chrome://inspect, then press Ctrl+C.");
process.on("SIGINT", () => child.kill("SIGTERM"));
child.on("exit", () => process.exit(0));
