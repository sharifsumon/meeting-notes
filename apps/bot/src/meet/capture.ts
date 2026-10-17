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
    __mfLevel?: () => { peak: number; rms: number; tracks: number; liveTracks: number };
  };
  const w = window as Win;

  let ctx: AudioContext | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  let recorder: MediaRecorder | null = null;
  let analyser: AnalyserNode | null = null;
  let peak = 0;
  let sumSquares = 0;
  let samples = 0;
  const tracks: MediaStreamTrack[] = [];
  const connected = new Set<string>();

  const connect = (track: MediaStreamTrack) => {
    if (!ctx || !dest || connected.has(track.id)) return;
    connected.add(track.id);
    const stream = new MediaStream([track]);
    // Chrome only feeds a remote WebRTC track into Web Audio while a media element is playing it.
    const sink = new Audio();
    sink.muted = true;
    sink.srcObject = stream;
    void sink.play().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    source.connect(dest);
    if (analyser) source.connect(analyser);
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
    (w as Win & { __mfT0?: number }).__mfT0 = performance.now();
    ctx = new AudioContext();
    dest = ctx.createMediaStreamDestination();
    // A silent source keeps the recording timeline running while nobody speaks.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.connect(dest);
    silence.start();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const buf = new Float32Array(analyser.fftSize);
    // Samples the mixed level every second so the bot can tell when it only hears silence.
    setInterval(() => {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) {
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sumSquares += v * v;
      }
      samples += buf.length;
    }, 1_000);
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

  /** Peak and RMS level (0–1) of everything heard since the last call. */
  w.__mfLevel = () => {
    const level = {
      peak,
      rms: samples ? Math.sqrt(sumSquares / samples) : 0,
      tracks: connected.size,
      liveTracks: tracks.filter((t) => t.readyState === "live").length,
    };
    peak = 0;
    sumSquares = 0;
    samples = 0;
    return level;
  };
}

/**
 * Runs inside the meeting page once captions are on. Meet's captions show each speaker's name
 * above what they say; this notes who spoke when (relative to the recording's start) so the
 * transcript's "Speaker N" labels can be swapped for names afterwards.
 *
 * Meet's class names change often, so blocks are found by shape: a caption block holds the
 * speaker's avatar image, their name on the first line and the words below it.
 */
export function installCaptionWatcher() {
  type Turn = { name: string; startMs: number; endMs: number };
  type Stats = { regionSeen: number; blocksSeen: number; sample: string };
  type Win = typeof window & { __mfT0?: number; __mfSpeakers?: () => Turn[]; __mfCaptionStats?: () => Stats };
  const w = window as Win;
  if (w.__mfSpeakers) return;

  // Captions trail speech by about a second.
  const LAG_MS = 1_000;
  const turns: Turn[] = [];
  const seen = new WeakMap<Element, { turn: Turn; text: string }>();
  const now = () => Math.max(0, performance.now() - (w.__mfT0 ?? 0));
  // For diagnosing calls where captions were on but no speakers were noted.
  const stats: Stats = { regionSeen: 0, blocksSeen: 0, sample: "" };

  const blockFor = (img: Element, region: Element) => {
    let el: Element | null = img.parentElement;
    while (el && el !== region) {
      const lines = (el as HTMLElement).innerText.split("\n").filter((l) => l.trim());
      if (lines.length >= 2) return { el, lines };
      el = el.parentElement;
    }
    return null;
  };

  setInterval(() => {
    const region =
      document.querySelector('[role="region"][aria-label*="aption" i]') ??
      document.querySelector('[aria-label*="aption" i]:not(button):not([role="button"]):not([role="menuitem"])');
    if (!region) return;
    stats.regionSeen++;
    if (!stats.sample) stats.sample = (region as HTMLElement).innerText.slice(0, 120);
    const t = now();
    for (const img of Array.from(region.querySelectorAll("img"))) {
      const block = blockFor(img, region);
      if (!block) continue;
      stats.blocksSeen++;
      const name = block.lines[0]!.trim();
      const text = block.lines.slice(1).join(" ");
      const known = seen.get(block.el);
      if (!known || known.turn.name !== name) {
        const turn = { name, startMs: Math.max(0, t - LAG_MS - 1_000), endMs: Math.max(0, t - LAG_MS) };
        turns.push(turn);
        seen.set(block.el, { turn, text });
      } else if (known.text !== text) {
        known.text = text;
        known.turn.endMs = Math.max(known.turn.endMs, t - LAG_MS);
      }
    }
  }, 500);

  w.__mfSpeakers = () => turns.filter((t) => t.name.toLowerCase() !== "you");
  w.__mfCaptionStats = () => stats;
}
