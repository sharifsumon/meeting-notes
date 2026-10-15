"use client";

/** The meeting's recording, full width. Transcript timestamps seek it via seekAudio(). */
export function AudioPlayer({ src, minutes }: { src: string; minutes: number | null }) {
  return (
    <section className="card flex flex-col gap-3 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-bold">Meeting audio</h2>
        {minutes && <span className="text-sm text-muted">{minutes} min</span>}
      </div>
      <audio id="meeting-audio" controls preload="metadata" src={src} className="w-full" />
    </section>
  );
}

export function seekAudio(ms: number) {
  const audio = document.getElementById("meeting-audio") as HTMLAudioElement | null;
  if (!audio) return;
  audio.currentTime = ms / 1000;
  void audio.play().catch(() => {});
  audio.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
