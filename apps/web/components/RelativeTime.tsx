"use client";

import { useEffect, useState } from "react";
import { formatLondonTime, relativeTime } from "../lib/format";

/** Live relative timestamp that re-renders every 30s. Title shows exact time. */
export function RelativeTime({
  value,
  className,
}: {
  value: string | number | Date;
  className?: string;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className={className}
      title={formatLondonTime(value, true)}
      suppressHydrationWarning
    >
      {relativeTime(value)}
    </span>
  );
}
