// Daily Brief email template (spec §9.7, docs/phase3/CONTRACTS.md — P3-DELIVERY).
// React Email component: hero numbers, agency summary, needs-attention, wins,
// and a compact per-project table. Dark-on-light, email-safe INLINE styles only
// (no <style>, no external CSS — many mail clients strip both).
import {
  Body,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

/** Hero tiles shown at the top of the brief. */
export interface BriefHeroNumbers {
  mrrPence: number;
  liveProjects: number;
  activeClients: number;
  health: { green: number; amber: number; red: number };
}

/** One row in the compact per-project table. */
export interface BriefProjectRow {
  name: string;
  clientName: string;
  /** 'green' | 'amber' | 'red' (free-form; unknown → neutral dot). */
  health: string;
  /** Optional one-line "what's worth saying" summary. */
  summary?: string;
  revenueYesterdayPence?: number;
  minutesSavedYesterday?: number;
}

/** Full typed model the template renders. Built by the brief agent (Wave 2). */
export interface DailyBriefEmailModel {
  headline: string;
  heroNumbers: BriefHeroNumbers;
  /** Plain text; blank-line-separated into simple paragraphs (no MD parser). */
  agencySummaryMd: string;
  needsAttention: string[];
  wins: string[];
  projects: BriefProjectRow[];
  /** Optional London day label for the sub-header, e.g. "Sat 12 Jul 2026". */
  dayLabel?: string;
}

const PALETTE = {
  bg: "#f4f5f7",
  card: "#ffffff",
  ink: "#1a1d23",
  muted: "#5b6472",
  faint: "#8a93a2",
  border: "#e4e7ec",
  accent: "#2f5bea",
  green: "#1f9d55",
  amber: "#d9820b",
  red: "#d64545",
} as const;

function formatPence(pence: number): string {
  const negative = pence < 0;
  const abs = Math.abs(Math.round(pence));
  const pounds = Math.floor(abs / 100);
  const rem = abs % 100;
  const withThousands = pounds.toLocaleString("en-GB");
  return `${negative ? "-" : ""}£${withThousands}.${rem.toString().padStart(2, "0")}`;
}

function healthColor(health: string): string {
  switch (health.toLowerCase()) {
    case "green":
      return PALETTE.green;
    case "amber":
      return PALETTE.amber;
    case "red":
      return PALETTE.red;
    default:
      return PALETTE.faint;
  }
}

function toParagraphs(md: string): string[] {
  return md
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

const styles = {
  body: {
    backgroundColor: PALETTE.bg,
    margin: "0",
    padding: "0",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    color: PALETTE.ink,
  } as React.CSSProperties,
  container: {
    maxWidth: "600px",
    margin: "0 auto",
    padding: "24px 12px",
  } as React.CSSProperties,
  card: {
    backgroundColor: PALETTE.card,
    borderRadius: "12px",
    border: `1px solid ${PALETTE.border}`,
    padding: "28px 28px 24px",
  } as React.CSSProperties,
  eyebrow: {
    fontSize: "12px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: PALETTE.faint,
    margin: "0 0 6px",
  } as React.CSSProperties,
  headline: {
    fontSize: "22px",
    lineHeight: "1.3",
    fontWeight: 700,
    color: PALETTE.ink,
    margin: "0 0 20px",
  } as React.CSSProperties,
  heroTile: {
    padding: "0 8px",
    verticalAlign: "top",
  } as React.CSSProperties,
  heroValue: {
    fontSize: "24px",
    fontWeight: 700,
    color: PALETTE.ink,
    margin: "0",
  } as React.CSSProperties,
  heroLabel: {
    fontSize: "12px",
    color: PALETTE.muted,
    margin: "2px 0 0",
  } as React.CSSProperties,
  hr: {
    borderColor: PALETTE.border,
    margin: "22px 0",
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: "13px",
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: PALETTE.muted,
    margin: "0 0 10px",
  } as React.CSSProperties,
  paragraph: {
    fontSize: "15px",
    lineHeight: "1.6",
    color: PALETTE.ink,
    margin: "0 0 12px",
  } as React.CSSProperties,
  listItem: {
    fontSize: "14px",
    lineHeight: "1.5",
    color: PALETTE.ink,
    margin: "0 0 8px",
    paddingLeft: "14px",
    position: "relative",
  } as React.CSSProperties,
  tableHeadCell: {
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: PALETTE.faint,
    padding: "0 6px 6px 0",
    textAlign: "left",
  } as React.CSSProperties,
  tableCell: {
    fontSize: "13px",
    color: PALETTE.ink,
    padding: "8px 6px 8px 0",
    borderTop: `1px solid ${PALETTE.border}`,
    verticalAlign: "top",
  } as React.CSSProperties,
  footer: {
    fontSize: "12px",
    color: PALETTE.faint,
    textAlign: "center",
    margin: "18px 0 0",
  } as React.CSSProperties,
} satisfies Record<string, React.CSSProperties>;

export function DailyBriefEmail(model: DailyBriefEmailModel): React.ReactElement {
  const {
    headline,
    heroNumbers,
    agencySummaryMd,
    needsAttention,
    wins,
    projects,
    dayLabel,
  } = model;
  const paragraphs = toParagraphs(agencySummaryMd);
  const { green, amber, red } = heroNumbers.health;

  return (
    <Html lang="en">
      <Head />
      <Preview>{headline}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.card}>
            <Text style={styles.eyebrow}>
              Daily Brief{dayLabel ? ` · ${dayLabel}` : ""}
            </Text>
            <Heading as="h1" style={styles.headline}>
              {headline}
            </Heading>

            {/* Hero numbers */}
            <Row>
              <Column style={styles.heroTile}>
                <Text style={styles.heroValue}>
                  {formatPence(heroNumbers.mrrPence)}
                </Text>
                <Text style={styles.heroLabel}>MRR</Text>
              </Column>
              <Column style={styles.heroTile}>
                <Text style={styles.heroValue}>{heroNumbers.liveProjects}</Text>
                <Text style={styles.heroLabel}>Live projects</Text>
              </Column>
              <Column style={styles.heroTile}>
                <Text style={styles.heroValue}>{heroNumbers.activeClients}</Text>
                <Text style={styles.heroLabel}>Active clients</Text>
              </Column>
              <Column style={styles.heroTile}>
                <Text style={styles.heroValue}>
                  <span style={{ color: PALETTE.green }}>{green}</span>
                  {" / "}
                  <span style={{ color: PALETTE.amber }}>{amber}</span>
                  {" / "}
                  <span style={{ color: PALETTE.red }}>{red}</span>
                </Text>
                <Text style={styles.heroLabel}>Health G/A/R</Text>
              </Column>
            </Row>

            <Hr style={styles.hr} />

            {/* Agency summary */}
            <Text style={styles.sectionTitle}>Summary</Text>
            {paragraphs.length > 0 ? (
              paragraphs.map((p, i) => (
                <Text key={i} style={styles.paragraph}>
                  {p}
                </Text>
              ))
            ) : (
              <Text style={styles.paragraph}>No summary for today.</Text>
            )}

            {/* Needs attention */}
            {needsAttention.length > 0 ? (
              <>
                <Hr style={styles.hr} />
                <Text style={styles.sectionTitle}>Needs attention</Text>
                {needsAttention.map((item, i) => (
                  <Text key={i} style={{ ...styles.listItem, color: PALETTE.red }}>
                    <span
                      style={{
                        position: "absolute",
                        left: "0",
                        color: PALETTE.red,
                      }}
                    >
                      •
                    </span>
                    {item}
                  </Text>
                ))}
              </>
            ) : null}

            {/* Wins */}
            {wins.length > 0 ? (
              <>
                <Hr style={styles.hr} />
                <Text style={styles.sectionTitle}>Wins</Text>
                {wins.map((item, i) => (
                  <Text key={i} style={styles.listItem}>
                    <span
                      style={{
                        position: "absolute",
                        left: "0",
                        color: PALETTE.green,
                      }}
                    >
                      •
                    </span>
                    {item}
                  </Text>
                ))}
              </>
            ) : null}

            {/* Per-project table */}
            {projects.length > 0 ? (
              <>
                <Hr style={styles.hr} />
                <Text style={styles.sectionTitle}>Projects</Text>
                <table
                  role="presentation"
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  style={{ borderCollapse: "collapse", width: "100%" }}
                >
                  <thead>
                    <tr>
                      <th style={styles.tableHeadCell}>Project</th>
                      <th style={styles.tableHeadCell}>Client</th>
                      <th style={{ ...styles.tableHeadCell, textAlign: "right" }}>
                        Rev (yest)
                      </th>
                      <th style={{ ...styles.tableHeadCell, textAlign: "right" }}>
                        Mins saved
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p, i) => (
                      <tr key={i}>
                        <td style={styles.tableCell}>
                          <span
                            style={{
                              display: "inline-block",
                              width: "8px",
                              height: "8px",
                              borderRadius: "50%",
                              backgroundColor: healthColor(p.health),
                              marginRight: "6px",
                            }}
                          />
                          <strong>{p.name}</strong>
                          {p.summary ? (
                            <div
                              style={{
                                color: PALETTE.muted,
                                fontSize: "12px",
                                marginTop: "2px",
                              }}
                            >
                              {p.summary}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ ...styles.tableCell, color: PALETTE.muted }}>
                          {p.clientName}
                        </td>
                        <td style={{ ...styles.tableCell, textAlign: "right" }}>
                          {typeof p.revenueYesterdayPence === "number"
                            ? formatPence(p.revenueYesterdayPence)
                            : "—"}
                        </td>
                        <td style={{ ...styles.tableCell, textAlign: "right" }}>
                          {typeof p.minutesSavedYesterday === "number"
                            ? p.minutesSavedYesterday
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
          </Section>
          <Text style={styles.footer}>
            Azen OS · automated daily brief. Numbers reflect the latest complete
            London day.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default DailyBriefEmail;
