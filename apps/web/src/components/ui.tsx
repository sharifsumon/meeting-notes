import type { MeetingPlatform } from "@/lib/meeting-links";

export type BotStatus =
  | "scheduled"
  | "joining"
  | "waiting_room"
  | "recording"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export const PLATFORM: Record<MeetingPlatform, { label: string; dot: string; tint: string }> = {
  google_meet: { label: "Google Meet", dot: "#16a34a", tint: "border-green-200 bg-green-50 text-green-950" },
  microsoft_teams: { label: "Teams", dot: "#7c3aed", tint: "border-violet-200 bg-violet-50 text-violet-950" },
  zoom: { label: "Zoom", dot: "#2563eb", tint: "border-blue-200 bg-blue-50 text-blue-950" },
  webex: { label: "Webex", dot: "#0891b2", tint: "border-cyan-200 bg-cyan-50 text-cyan-950" },
  other: { label: "Video call", dot: "#64748b", tint: "border-slate-200 bg-slate-50 text-slate-900" },
};

// Platforms the bot can join today.
export const SUPPORTED_PLATFORMS: ReadonlySet<MeetingPlatform> = new Set(["google_meet"]);

const STATUS: Record<BotStatus, { label: string; className: string }> = {
  scheduled: { label: "Bot scheduled", className: "bg-slate-100 text-slate-600" },
  joining: { label: "Bot joining", className: "bg-sky-100 text-sky-800" },
  waiting_room: { label: "Waiting to be admitted", className: "bg-amber-100 text-amber-800" },
  recording: { label: "Recording", className: "bg-red-100 text-red-700" },
  processing: { label: "Processing", className: "bg-sky-100 text-sky-800" },
  completed: { label: "Recorded", className: "bg-green-100 text-green-800" },
  failed: { label: "Bot couldn't record", className: "bg-red-50 text-red-700" },
  cancelled: { label: "Skipped", className: "bg-slate-100 text-slate-600" },
};

/** The pill shown on a meeting: the bot's progress if it has one, otherwise whether recording is planned. */
export function StatusPill({
  status,
  recordEnabled,
  hasNotes = false,
}: {
  status: BotStatus | null;
  recordEnabled: boolean;
  hasNotes?: boolean;
}) {
  if (status === "completed" && hasNotes) return <span className="pill bg-green-100 text-green-800">Notes ready</span>;
  if (status) {
    const s = STATUS[status];
    return <span className={`pill ${s.className}`}>{s.label}</span>;
  }
  if (recordEnabled) return <span className="pill bg-slate-100 text-slate-600">Scheduled</span>;
  return null;
}

export function PlatformChip({ platform }: { platform: MeetingPlatform | null }) {
  if (!platform) return <span className="chip font-medium text-muted">No video link</span>;
  const p = PLATFORM[platform];
  return (
    <span className="chip">
      <span className="size-2 rounded-full" style={{ background: p.dot }} />
      {p.label}
    </span>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true">
      <rect width="36" height="36" rx="10" fill="#0f172a" />
      <path d="M11 20v-4M15 24V12M19 22v-8M23 19v-2" stroke="#f97316" strokeWidth="2.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

type IconName = "meetings" | "calendar" | "settings" | "clock" | "back" | "download" | "spark" | "search" | "check" | "video" | "chevron-left" | "chevron-right" | "refresh";

const PATHS: Record<IconName, React.ReactNode> = {
  meetings: (
    <>
      <path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  video: (
    <>
      <path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  back: <path d="m12 19-7-7 7-7M19 12H5" />,
  download: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  spark: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 17v4M17 19h4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </>
  ),
};

export function Icon({ name, size = 18, className, strokeWidth = 2 }: { name: IconName; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}

export function initials(nameOrEmail: string | null | undefined): string {
  const base = (nameOrEmail ?? "").split("@")[0] ?? "";
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? (parts[0]![0] ?? "") + (parts[1]![0] ?? "") : base.slice(0, 2);
  return letters.toUpperCase() || "?";
}
