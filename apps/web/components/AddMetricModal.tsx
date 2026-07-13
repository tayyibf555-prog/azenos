"use client";

import { useEffect, useMemo, useState } from "react";
import { EVENT_TYPES } from "@azen/events";
import { Modal } from "./Modal";
import { LineChart } from "./charts/LineChart";
import { formatMetricValue, londonShortDate, metricColor } from "./charts/util";
import {
  METRIC_AGGREGATIONS,
  METRIC_UNITS,
} from "./metrics-types";
import type {
  ApiErrorShape,
  CreateMetricBody,
  CreateMetricResponse,
  GoodDirection,
  MetricAggregation,
  MetricPreviewResponse,
  MetricUnit,
} from "./metrics-types";

const KEY_RE = /^[a-z][a-z0-9_]{1,48}$/;

/** name → candidate metric key: lowercase, non-alphanumerics collapse to `_`. */
function slugifyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 49);
}

interface WhereRow {
  key: string;
  value: string;
}

/**
 * Add-metric form with a debounced live preview (§8.2). Builds a CreateMetricBody
 * from the fields, POSTs it to /preview (no writes) to render a mini chart +
 * sample extractions, and on Save POSTs to /metrics. 409 (dup key) and 400
 * (invalid def) surface inline.
 */
export function AddMetricModal({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [eventType, setEventType] = useState("*");
  const [aggregation, setAggregation] = useState<MetricAggregation>("count");
  const [unit, setUnit] = useState<MetricUnit>("count");
  const [valuePath, setValuePath] = useState("");
  const [whereRows, setWhereRows] = useState<WhereRow[]>([]);
  const [goodDirection, setGoodDirection] = useState<GoodDirection>("up");
  const [isKpi, setIsKpi] = useState(false);

  const [preview, setPreview] = useState<MetricPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Event types actually observed on this project's events (contract: the
  // select offers "taxonomy + seen types" so custom, non-taxonomy types are
  // targetable). Sourced from GET /api/projects/[projectId] → eventTypesSeen.
  const [seenTypes, setSeenTypes] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch(`/api/projects/${projectId}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json()) as { eventTypesSeen?: unknown };
        if (Array.isArray(json.eventTypesSeen)) {
          setSeenTypes(json.eventTypesSeen.filter((t): t is string => typeof t === "string"));
        }
      })
      .catch(() => {
        /* seen types are additive — degrade to the fixed taxonomy on failure */
      });
    return () => controller.abort();
  }, [open, projectId]);

  // Union of the fixed 41-type taxonomy with any observed-but-custom types.
  const eventTypeOptions = useMemo(() => {
    const set = new Set<string>(EVENT_TYPES);
    for (const t of seenTypes) if (t) set.add(t);
    return [...set].sort();
  }, [seenTypes]);

  const key = useMemo(() => slugifyKey(name), [name]);
  const keyValid = KEY_RE.test(key);

  function reset() {
    setName("");
    setEventType("*");
    setAggregation("count");
    setUnit("count");
    setValuePath("");
    setWhereRows([]);
    setGoodDirection("up");
    setIsKpi(false);
    setPreview(null);
    setSaveError(null);
  }

  const whereEquals = useMemo<Record<string, string> | null>(() => {
    const obj: Record<string, string> = {};
    for (const row of whereRows) {
      const k = row.key.trim();
      if (k) obj[k] = row.value;
    }
    return Object.keys(obj).length > 0 ? obj : null;
  }, [whereRows]);

  const body = useMemo<CreateMetricBody | null>(() => {
    if (!name.trim() || !keyValid || !eventType) return null;
    return {
      key,
      name: name.trim(),
      unit,
      aggregation,
      eventType,
      valuePath: valuePath.trim() ? valuePath.trim() : null,
      whereEquals,
      goodDirection,
      isKpi,
    };
  }, [
    name,
    key,
    keyValid,
    unit,
    aggregation,
    eventType,
    valuePath,
    whereEquals,
    goodDirection,
    isKpi,
  ]);

  // debounced live preview
  useEffect(() => {
    if (!open || !body) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    setPreviewing(true);
    const t = setTimeout(() => {
      fetch(`/api/projects/${projectId}/metrics/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (res) => {
          const json = (await res.json()) as
            | MetricPreviewResponse
            | ApiErrorShape;
          if (!res.ok || "error" in json) {
            setPreview(null);
            return;
          }
          setPreview(json);
        })
        .catch(() => {
          /* aborted or transient — leave last good preview cleared */
        })
        .finally(() => setPreviewing(false));
    }, 500);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
  }, [open, body, projectId]);

  async function save() {
    if (!body || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (res.status === 201) {
        const json = (await res.json()) as CreateMetricResponse;
        void json;
        reset();
        onCreated();
        onClose();
        return;
      }
      if (res.status === 409) {
        setSaveError(`A metric with the key “${key}” already exists.`);
        return;
      }
      const err = (await res.json().catch(() => null)) as ApiErrorShape | null;
      setSaveError(
        err?.error === "invalid_definition" || res.status === 400
          ? "This definition is invalid — check the aggregation and value path."
          : "Couldn’t save the metric. Try again.",
      );
    } catch {
      setSaveError("Couldn’t reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const previewPoints =
    preview?.series.map((p) => ({ periodStart: p.periodStart, value: p.value })) ??
    [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add metric"
      width={720}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: 22,
        }}
      >
        {/* ── form ── */}
        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
          <div>
            <label className="label" htmlFor="am-name">
              Name
            </label>
            <input
              id="am-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Qualified leads"
            />
            <div className="faint" style={{ fontSize: 11, marginTop: 5 }}>
              Key:{" "}
              <code className="mono" style={{ color: keyValid ? "var(--green)" : "var(--red)" }}>
                {key || "—"}
              </code>
              {!keyValid && name.trim() ? (
                <span style={{ color: "var(--red)" }}>
                  {" "}
                  · must match a…z, 2–49 chars
                </span>
              ) : null}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="am-event">
              Event type
            </label>
            <select
              id="am-event"
              className="input"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
            >
              <option value="*">* (all types)</option>
              {eventTypeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label className="label" htmlFor="am-agg">
                Aggregation
              </label>
              <select
                id="am-agg"
                className="input"
                value={aggregation}
                onChange={(e) =>
                  setAggregation(e.target.value as MetricAggregation)
                }
              >
                {METRIC_AGGREGATIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="am-unit">
                Unit
              </label>
              <select
                id="am-unit"
                className="input"
                value={unit}
                onChange={(e) => setUnit(e.target.value as MetricUnit)}
              >
                {METRIC_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="am-vp">
              Value path
            </label>
            <input
              id="am-vp"
              className="input mono"
              value={valuePath}
              onChange={(e) => setValuePath(e.target.value)}
              placeholder="$.data.amount_pence"
            />
            <div className="faint" style={{ fontSize: 11, marginTop: 5 }}>
              e.g. <code className="mono">$.data.&lt;key&gt;</code> or{" "}
              <code className="mono">$.value_pence</code>. Leave blank to count
              matching events.
            </div>
          </div>

          <div>
            <label className="label">Where equals (optional)</label>
            <div style={{ display: "grid", gap: 7 }}>
              {whereRows.map((row, i) => (
                <div key={i} style={{ display: "flex", gap: 7 }}>
                  <input
                    className="input mono"
                    style={{ flex: 1 }}
                    value={row.key}
                    onChange={(e) =>
                      setWhereRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, key: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="$.data.success"
                  />
                  <input
                    className="input mono"
                    style={{ flex: 1 }}
                    value={row.value}
                    onChange={(e) =>
                      setWhereRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, value: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="true"
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    aria-label="Remove filter"
                    onClick={() =>
                      setWhereRows((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-sm"
                style={{ justifySelf: "start" }}
                onClick={() =>
                  setWhereRows((rows) => [...rows, { key: "", value: "" }])
                }
              >
                + Filter
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label className="label" htmlFor="am-dir">
                Good direction
              </label>
              <select
                id="am-dir"
                className="input"
                value={goodDirection}
                onChange={(e) =>
                  setGoodDirection(e.target.value as GoodDirection)
                }
              >
                <option value="up">up is good</option>
                <option value="down">down is good</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  cursor: "pointer",
                  height: 36,
                }}
              >
                <input
                  type="checkbox"
                  checked={isKpi}
                  onChange={(e) => setIsKpi(e.target.checked)}
                />
                Show as KPI
              </label>
            </div>
          </div>
        </div>

        {/* ── live preview ── */}
        <div style={{ display: "grid", gap: 12, minWidth: 0, alignContent: "start" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span className="label" style={{ margin: 0 }}>
              Live preview · last 30 days
            </span>
            {previewing && <span className="faint" style={{ fontSize: 11 }}>updating…</span>}
          </div>

          <div
            className="card"
            style={{ padding: 12, background: "var(--card-2)", minHeight: 150 }}
          >
            {!body ? (
              <div
                className="faint"
                style={{ height: 150, display: "grid", placeItems: "center", fontSize: 12.5 }}
              >
                Fill in a name and event type to preview.
              </div>
            ) : preview ? (
              <LineChart
                points={previewPoints}
                color={metricColor(0)}
                unit={unit}
                period="day"
              />
            ) : (
              <div
                className="faint"
                style={{ height: 150, display: "grid", placeItems: "center", fontSize: 12.5 }}
              >
                {previewing ? "Evaluating…" : "No matching events in the window."}
              </div>
            )}
          </div>

          {preview && (
            <div className="faint" style={{ fontSize: 12 }}>
              Total:{" "}
              <span style={{ color: "var(--text)", fontWeight: 600 }}>
                {formatMetricValue(preview.total, unit)}
              </span>
            </div>
          )}

          {preview && preview.sampleEvents.length > 0 && (
            <div>
              <div className="faint" style={{ fontSize: 11, marginBottom: 6 }}>
                Sample extractions
              </div>
              <div style={{ display: "grid", gap: 5 }}>
                {preview.sampleEvents.slice(0, 5).map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      fontSize: 11.5,
                    }}
                  >
                    <span className="faint">{londonShortDate(s.occurredAt)}</span>
                    <span className="mono" style={{ color: "var(--text-2)" }}>
                      {s.extracted === null ? "∅" : String(s.extracted)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {saveError && (
        <div
          style={{
            marginTop: 16,
            fontSize: 12.5,
            color: "var(--red)",
          }}
        >
          {saveError}
        </div>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          marginTop: 18,
          paddingTop: 16,
          borderTop: "1px solid var(--border)",
        }}
      >
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!body || saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save metric"}
        </button>
      </div>
    </Modal>
  );
}
