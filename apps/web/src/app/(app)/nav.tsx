"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui";

const ITEMS = [
  { href: "/meetings", label: "Meetings", icon: "meetings" },
  { href: "/calendar", label: "Calendar", icon: "calendar" },
  { href: "/settings", label: "Settings", icon: "settings" },
] as const;

export function SideNav({ upcoming }: { upcoming: number }) {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 md:flex-col">
      {ITEMS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 items-center gap-3 rounded-[10px] px-3 text-[15px] ${
              active ? "bg-accent-soft font-semibold text-accent" : "font-medium text-ink-2 hover:bg-white/70"
            }`}
          >
            <Icon name={item.icon} size={19} />
            {item.label}
            {item.href === "/meetings" && upcoming > 0 && (
              <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-xs font-bold text-accent max-md:hidden">{upcoming}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

const TITLES: Record<string, string> = { meetings: "Meetings", calendar: "Calendar", settings: "Settings" };

export function Breadcrumb() {
  const [section, sub] = usePathname().split("/").filter(Boolean);
  const title = TITLES[section ?? ""] ?? "";
  return (
    <p className="m-0 flex items-center gap-2 text-sm text-muted">
      {sub ? (
        <>
          <Link href={`/${section}`} className="hover:text-ink">
            {title}
          </Link>
          <span aria-hidden="true">/</span>
          <strong className="font-semibold text-ink">Meeting details</strong>
        </>
      ) : (
        <strong className="font-semibold text-ink">{title}</strong>
      )}
    </p>
  );
}
