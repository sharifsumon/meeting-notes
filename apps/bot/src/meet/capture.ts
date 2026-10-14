/**
 * Runs inside the meeting page (added with page.addInitScript before the page loads).
 *
 * Meet delivers each participant's audio as a remote WebRTC track. We wrap
 * RTCPeerConnection to catch every remote audio track, mix them into one stream
 * with Web Audio, and record that with MediaRecorder. Chunks go to Node through
 * the exposed `__mfChunk` binding as base64.
 */
export function installAudioCapture() {
  type Win = typeof window & {
    __mfChunk?: (b64: string) => Promise<void>;
    __mfStart?: () => void;
    __mfStop?: () => Promise<void>;
    __mfTrackCount?: () => number;
  };
  const w = window as Win;

  let ctx: AudioContext | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  let recorder: MediaRecorder | null = null;
  const tracks: MediaStreamTrack[] = [];
  const connected = new Set<string>();

  const connect = (track: MediaStreamTrack) => {
    if (!ctx || !dest || connected.has(track.id)) return;
    connected.add(track.id);
    ctx.createMediaStreamSource(new MediaStream([track])).connect(dest);
  };

  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Original {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      this.addEventListener("track", (e) => {
        if (e.track.kind !== "audio") return;
        tracks.push(e.track);
        connect(e.track);
      });
    }
  } as typeof RTCPeerConnection;

  const blobToBase64 = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

  w.__mfStart = () => {
    if (recorder) return;
    ctx = new AudioContext();
    dest = ctx.createMediaStreamDestination();
    // A silent source keeps the recording timeline running while nobody speaks.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.connect(dest);
    silence.start();
    tracks.filter((t) => t.readyState === "live").forEach(connect);

    recorder = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64_000 });
    recorder.ondataavailable = async (e) => {
      if (e.data.size > 0) await w.__mfChunk?.(await blobToBase64(e.data));
    };
    recorder.start(5_000);
  };

  w.__mfStop = () =>
    new Promise<void>((resolve) => {
      if (!recorder || recorder.state === "inactive") return resolve();
      const r = recorder;
      // Resolve after the final dataavailable has been handed to Node.
      r.addEventListener("stop", () => setTimeout(resolve, 500), { once: true });
      r.stop();
    });

  w.__mfTrackCount = () => connected.size;
}
