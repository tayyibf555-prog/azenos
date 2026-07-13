import type { ReactNode } from "react";

const TOKEN =
  /("(?:\\.|[^"\\])*"\s*:?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlight(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(json)) !== null) {
    const tok = match[0];
    if (tok === undefined) break;
    if (match.index > last) out.push(json.slice(last, match.index));
    let color: string;
    if (tok.startsWith('"')) {
      color = tok.trimEnd().endsWith(":") ? "#7aa2f7" : "#7fd7a8";
    } else if (tok === "true" || tok === "false" || tok === "null") {
      color = "#bb9af7";
    } else {
      color = "#d9a441";
    }
    out.push(
      <span key={key++} style={{ color }}>
        {tok}
      </span>,
    );
    last = match.index + tok.length;
  }
  if (last < json.length) out.push(json.slice(last));
  return out;
}

/** Pretty-printed, lightly syntax-highlighted JSON. */
export function JsonView({
  value,
  maxHeight = 360,
}: {
  value: unknown;
  maxHeight?: number;
}) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return (
    <pre className="codeblock" style={{ maxHeight, overflow: "auto" }}>
      {highlight(text)}
    </pre>
  );
}
