import { TINTS, type SquircleTone } from "./tokens";

export interface CalendarEvent {
  /** ISO timestamp — the day it lands on is what matters. */
  date: string;
  tone?: SquircleTone;
}

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

const londonYMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** London Y-M-D key for a date, so dots land on the right calendar cell. */
function ymd(d: Date): string {
  return londonYMD.format(d); // "2026-07-17"
}

/**
 * §4 MiniCalendar — current-month grid, 28px day cells, a black selected circle
 * on today, and up-to-three pastel event dots under days that carry events.
 * Pure/SSR-safe; the month + "today" derive from `now` (defaults to render time).
 */
export function MiniCalendar({
  events = [],
  now = new Date(),
}: {
  events?: CalendarEvent[];
  now?: Date;
}) {
  const todayKey = ymd(now);
  const [y, m] = todayKey.split("-").map(Number) as [number, number, number];

  // Group event tones by day key.
  const byDay = new Map<string, SquircleTone[]>();
  for (const e of events) {
    const key = ymd(new Date(e.date));
    const list = byDay.get(key) ?? [];
    list.push(e.tone ?? "sky");
    byDay.set(key, list);
  }

  // Build the month grid, Monday-first.
  const first = new Date(Date.UTC(y, m - 1, 1));
  const startDow = (first.getUTCDay() + 6) % 7; // 0 = Monday
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div style={{ userSelect: "none" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>{monthLabel}</span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 2,
        }}
      >
        {WEEKDAYS.map((w, i) => (
          <span
            key={i}
            style={{
              height: 20,
              display: "grid",
              placeItems: "center",
              fontSize: 10.5,
              fontWeight: 600,
              color: "var(--text-3)",
            }}
          >
            {w}
          </span>
        ))}

        {cells.map((d, i) => {
          if (d === null) return <span key={i} style={{ height: 28 }} />;
          const key = `${String(y)}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const isToday = key === todayKey;
          const dots = (byDay.get(key) ?? []).slice(0, 3);
          return (
            <span
              key={i}
              style={{
                height: 28,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                position: "relative",
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "50%",
                  fontSize: 12,
                  fontWeight: isToday ? 640 : 500,
                  fontVariantNumeric: "tabular-nums",
                  background: isToday ? "var(--black-pill)" : "transparent",
                  color: isToday ? "#fff" : "var(--text)",
                }}
              >
                {d}
              </span>
              <span style={{ display: "flex", gap: 2, height: 4 }}>
                {dots.map((tone, di) => (
                  <span
                    key={di}
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: "50%",
                      background: isToday ? "#fff" : TINTS[tone].fg,
                    }}
                  />
                ))}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
