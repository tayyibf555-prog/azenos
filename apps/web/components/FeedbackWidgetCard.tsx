"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatLondonDate } from "../lib/format";
import { CopyBlock, CopyButton } from "./CopyBlock";
import { Modal } from "./Modal";
import { ToastViewport, useToasts } from "./Toast";
import { COLORS, tint } from "./ui";
import type { ApiError, ProjectKeyView } from "./types";

/**
 * Phase 7 §B — the "Feedback widget" Setup card: a self-contained embeddable
 * <script> (floating button → dark glass modal → POST), a curl example, and
 * the PUBLIC feedback key with revoke/reissue. No secret is ever shown — the
 * widget is designed to sit on a client's own site with the public key inline.
 */

/** ~2KB, dependency-free. Endpoint is inlined; no secret ships to the browser. */
function embedSnippet(endpoint: string): string {
  return `<script>(function(){
  var EP=${JSON.stringify(endpoint)};
  var K=["bug","feature","question","praise","other"];
  var S="position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:10px 16px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:#3f6bff;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.35)";
  var IN="width:100%;box-sizing:border-box;margin-bottom:8px;padding:8px 10px;border-radius:8px;background:#0e1016;color:#e7e9ee;border:1px solid rgba(255,255,255,.14);font:14px system-ui,sans-serif";
  var btn=document.createElement("button");btn.textContent="Feedback";btn.setAttribute("style",S);document.body.appendChild(btn);
  var ov=null;
  function close(){if(ov){ov.remove();ov=null;}}
  btn.onclick=function(){
    if(ov){close();return;}
    ov=document.createElement("div");
    ov.setAttribute("style","position:fixed;inset:0;z-index:2147483001;display:flex;align-items:flex-end;justify-content:flex-end;padding:20px;background:rgba(0,0,0,.3)");
    ov.onclick=function(e){if(e.target===ov)close();};
    var b=document.createElement("div");
    b.setAttribute("style","width:320px;max-width:calc(100vw - 40px);background:rgba(17,19,26,.94);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:16px;color:#e7e9ee;font:14px system-ui,sans-serif;box-shadow:0 16px 48px rgba(0,0,0,.55)");
    b.innerHTML='<div style="font-weight:600;margin-bottom:10px">Send feedback</div>'+
      '<select id="_azk" style="'+IN+'">'+K.map(function(k){return '<option value="'+k+'">'+k+'</option>';}).join("")+'</select>'+
      '<textarea id="_azm" rows="4" placeholder="What happened?" style="'+IN+';resize:vertical"></textarea>'+
      '<input id="_aze" type="email" placeholder="Email (optional)" style="'+IN+'">'+
      '<input id="_azw" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px">'+
      '<button id="_azs" style="width:100%;padding:9px;border:0;border-radius:8px;background:#3f6bff;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer">Send</button>'+
      '<div id="_azt" style="display:none;padding:10px 0 2px;color:#22cadb">Thanks — we got it.</div>';
    ov.appendChild(b);document.body.appendChild(ov);
    var q=function(id){return b.querySelector(id);};
    q("#_azs").onclick=function(){
      var msg=q("#_azm").value;if(!msg){q("#_azm").focus();return;}
      var p={kind:q("#_azk").value,message:msg,website:q("#_azw").value,page_url:location.href};
      var em=q("#_aze").value;if(em)p.submitter={email:em};
      q("#_azs").disabled=true;
      fetch(EP,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(p)})
        .then(function(){q("#_azs").style.display="none";q("#_azt").style.display="block";setTimeout(close,1500);})
        .catch(function(){q("#_azs").disabled=false;});
    };
  };
})();</script>`;
}

function curlExample(endpoint: string): string {
  return `curl -X POST '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -d '{"kind":"bug","message":"Booking button does nothing on mobile","severity":2,"page_url":"https://client.example/book"}'`;
}

export function FeedbackWidgetCard({
  projectId,
  feedbackKey,
  origin,
}: {
  projectId: string;
  feedbackKey: ProjectKeyView | null;
  origin: string;
}) {
  const router = useRouter();
  const { toasts, show } = useToasts();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const publicKey = feedbackKey?.publicKey ?? "";
  const endpoint = publicKey
    ? `${origin || ""}/api/feedback/${publicKey}`
    : "";

  async function reissue() {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/keys/feedback/revoke`,
        { method: "POST" },
      );
      const json = (await res.json()) as { publicKey?: string } | ApiError;
      if (!res.ok || "error" in json) {
        show("error" in json ? json.error : "Reissue failed", "error");
        return;
      }
      setConfirm(false);
      show("Feedback key reissued — re-paste the widget snippet", "success");
      router.refresh();
    } catch {
      show("Network error reissuing feedback key", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ padding: 18 }}>
      <h3 style={{ fontSize: 14, marginBottom: 6 }}>Feedback widget</h3>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
        Drop this snippet on the client&rsquo;s site (or any internal tool) to
        collect bugs, feature requests and questions straight into{" "}
        <strong>Analytics → Feedback</strong>. It ships a floating button and a
        small modal — no dependencies, and{" "}
        <strong>no secret is exposed</strong> (the public key can only create
        feedback).
      </p>

      {!feedbackKey ? (
        <p className="faint" style={{ fontSize: 13 }}>
          No feedback key yet — reissue one below.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 6,
              }}
            >
              <span className="label">Embeddable snippet</span>
              <CopyButton value={embedSnippet(endpoint)} className="btn btn-sm" />
            </div>
            <pre className="codeblock" style={{ maxHeight: 220 }}>
              {embedSnippet(endpoint)}
            </pre>
          </div>

          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 6,
              }}
            >
              <span className="label">curl</span>
              <CopyButton value={curlExample(endpoint)} className="btn btn-sm" />
            </div>
            <pre className="codeblock">{curlExample(endpoint)}</pre>
          </div>

          <CopyBlock label="Feedback endpoint" value={endpoint} />

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 14,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="label" style={{ marginBottom: 4 }}>
                Public key
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  className="mono truncate"
                  style={{ fontSize: 12.5 }}
                  title={publicKey}
                >
                  {publicKey}
                </span>
                <CopyButton value={publicKey} className="btn btn-ghost btn-sm" />
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="label" style={{ marginBottom: 4 }}>
                Kind
              </div>
              <span
                className="badge"
                style={{
                  color: COLORS.teal,
                  background: tint(COLORS.teal, 0.12),
                  borderColor: tint(COLORS.teal, 0.28),
                }}
              >
                FEEDBACK · public
              </span>
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="label" style={{ marginBottom: 4 }}>
                Created
              </div>
              <span style={{ fontSize: 13 }}>
                {formatLondonDate(feedbackKey.createdAt)}
              </span>
            </div>
          </div>

          <div>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => setConfirm(true)}
              disabled={busy}
            >
              Revoke &amp; reissue widget key
            </button>
          </div>
        </div>
      )}

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Reissue feedback key"
      >
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
          The current widget key is revoked and a new public key is minted. Any
          site still embedding the old snippet will stop sending feedback until
          you re-paste the new one. There is no secret to rotate.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button
            className="btn btn-danger btn-sm"
            onClick={reissue}
            disabled={busy}
          >
            {busy ? "Reissuing…" : "Revoke & reissue"}
          </button>
        </div>
      </Modal>

      <ToastViewport toasts={toasts} />
    </section>
  );
}
