import type { ReactNode } from "react";

/**
 * Tiny, dependency-free Markdown renderer for agent-authored brief bodies
 * (headline/agency summary/per-project paragraphs/needs-attention/wins). Pure
 * and server-safe — NO dangerouslySetInnerHTML, so the LLM output can never
 * inject markup. Supports the small subset the brief agent emits: ATX headings
 * (`#`–`###`), unordered lists (`-`/`*`), blank-line paragraphs, and inline
 * `**bold**` + `` `code` ``.
 */

let keySeq = 0;

/** Inline pass: **bold** and `code`. Everything else is plain text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      out.push(
        <strong key={`b${keySeq++}`} style={{ fontWeight: 650, color: "var(--text)" }}>
          {m[2]}
        </strong>,
      );
    } else if (m[3] !== undefined) {
      out.push(
        <code key={`c${keySeq++}`} className="kbd">
          {m[3]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({
  source,
  className,
}: {
  source: string | null | undefined;
  className?: string;
}): ReactNode {
  const text = (source ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];

  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(
      <p
        key={`p${keySeq++}`}
        style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--text-2)" }}
      >
        {inline(para.join(" "))}
      </p>,
    );
    para = [];
  };

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul
        key={`u${keySeq++}`}
        style={{
          margin: 0,
          paddingLeft: 18,
          display: "grid",
          gap: 4,
          fontSize: 13.5,
          lineHeight: 1.55,
          color: "var(--text-2)",
        }}
      >
        {list.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);

    if (heading) {
      flushPara();
      flushList();
      const level = heading[1]?.length ?? 1;
      const content = heading[2] ?? "";
      const size = level === 1 ? 16 : level === 2 ? 14.5 : 13;
      blocks.push(
        <div
          key={`h${keySeq++}`}
          style={{
            fontSize: size,
            fontWeight: 650,
            color: "var(--text)",
            marginTop: blocks.length ? 4 : 0,
            letterSpacing: "-0.01em",
          }}
        >
          {inline(content)}
        </div>,
      );
      continue;
    }

    if (bullet) {
      flushPara();
      list.push(bullet[1] ?? "");
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }

    flushList();
    para.push(line);
  }
  flushPara();
  flushList();

  if (blocks.length === 0) return null;
  return (
    <div className={className} style={{ display: "grid", gap: 10 }}>
      {blocks}
    </div>
  );
}
