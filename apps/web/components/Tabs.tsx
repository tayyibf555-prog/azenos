import Link from "next/link";

export interface TabDef {
  key: string;
  label: string;
  href?: string;
  disabled?: boolean;
  chip?: string;
}

/** Horizontal tab bar. Enabled tabs are links; disabled tabs carry a phase chip. */
export function Tabs({ tabs, activeKey }: { tabs: TabDef[]; activeKey: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 22,
        borderBottom: "1px solid var(--border)",
        overflowX: "auto",
      }}
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        const inner = (
          <>
            {tab.label}
            {tab.chip && <span className="chip">{tab.chip}</span>}
          </>
        );
        if (tab.disabled || !tab.href) {
          return (
            <span
              key={tab.key}
              className="tab tab-disabled"
              title="Arrives in a later phase"
            >
              {inner}
            </span>
          );
        }
        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={active ? "tab tab-active" : "tab"}
          >
            {inner}
          </Link>
        );
      })}
    </div>
  );
}
