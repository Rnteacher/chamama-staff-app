"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function BottomNav({
  totalUnread,
  showCalendar,
}: {
  totalUnread: number;
  showCalendar: boolean;
}) {
  const pathname = usePathname();

  const items = [
    { href: "/", label: "בית", icon: HomeIcon, badge: false },
    { href: "/updates", label: "עדכונים", icon: BellIcon, badge: true },
    ...(showCalendar
      ? [{ href: "/calendar", label: "לוח שנה", icon: CalendarIcon, badge: false }]
      : []),
    { href: "/groups", label: "קבוצות", icon: UsersIcon, badge: false },
    { href: "/settings", label: "הגדרות", icon: SettingsIcon, badge: false },
  ];

  function isActive(href: string): boolean {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <nav
      aria-label="ניווט ראשי"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul
        className="mx-auto grid max-w-3xl"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((item) => {
          const active = isActive(item.href);
          const badge = item.badge && totalUnread > 0;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-[56px] flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium ${
                  active ? "text-ink" : "text-muted"
                }`}
              >
                {/* the badge is anchored to the ICON (not the whole cell), so
                    it stays on the icon's upper corner at every width; its
                    right edge is pinned, so 2+ digits grow away from the icon */}
                <span className="relative inline-flex" data-nav-icon={item.href}>
                  <item.icon active={active} />
                  {badge && (
                    <span
                      aria-label={`${totalUnread} עדכונים שלא נקראו`}
                      data-unread-badge=""
                      className="absolute -top-1.5 right-[calc(100%-0.625rem)] grid h-5 min-w-5 place-items-center rounded-full bg-brand px-1 text-[10px] font-extrabold leading-none text-ink"
                    >
                      {totalUnread > 99 ? "99+" : totalUnread}
                    </span>
                  )}
                </span>
                <span className={active ? "font-bold" : undefined}>
                  {item.label}
                </span>
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 h-1 w-10 rounded-t-full bg-brand"
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 9.5V21h5v-6h4v6h5V9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BellIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z" strokeLinejoin="round" />
      <path d="M10 19a2 2 0 0 0 4 0" strokeLinecap="round" />
    </svg>
  );
}

function CalendarIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.5h17M8 2.8V6M16 2.8V6" strokeLinecap="round" />
    </svg>
  );
}

function UsersIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 1.8} aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5" strokeLinecap="round" />
      <path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M17.8 15.2c2 .6 3.3 2.1 3.9 4.3" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 1.8} aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path
        d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3 1a7.7 7.7 0 0 0-2.6-1.5L14 2.6h-4l-.5 2.5A7.7 7.7 0 0 0 6.9 6.6l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-1a7.7 7.7 0 0 0 2.6 1.5l.5 2.5h4l.5-2.5a7.7 7.7 0 0 0 2.6-1.5l2.3 1 2-3.4Z"
        strokeLinejoin="round"
      />
    </svg>
  );
}
