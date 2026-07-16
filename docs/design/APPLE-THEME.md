# Azen OS — Apple Theme v2 "Soft Light" (lead-pinned 2026-07-16, supersedes v1 dark)

Owner reference (2026-07-16): a light education-dashboard screenshot — soft off-white canvas,
white cards, BLACK pills for active states, pastel-TINT event chips (lavender/mint/peach/sky
with dark text), thin icons, generous radii. "No bright popping colours — more along these
lines when I say Apple aesthetic." That reference is authoritative for LOOK; principles from
docs/design/apple.md; density from linear.app.md. Numbers-first (§below) is unchanged.

> IMPLEMENTATION STATUS: the light repaint runs as its OWN dedicated workflow AFTER the
> Phase-8 fleet lands (scripts/workflows/apple-light.js). Until it executes, the app renders
> the v1 dark tokens. Phase-8 verifiers: verify TOKEN DISCIPLINE + layout + numbers-first,
> NOT light-vs-dark — the flip is scheduled, not a defect.

## Palette (exact tokens — remap VALUES in ui.ts COLORS + globals.css vars; keys unchanged)
- Canvas (outer bg)      `#F2F2F7`  (Apple systemGray6 — soft, never pure white)
- Surface / card         `#FFFFFF`  with hairline `#E5E5EA` border + very soft shadow
                          (0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04))
- Sidebar / chrome       white, hairline-separated; active nav = soft gray fill `#ECECF1`
                          or the BLACK pill for the primary selection
- Text primary           `#1D1D1F`  (Apple text-black) · secondary `#6E6E73` · tertiary `#AEAEB2`
- BLACK (selection)      `#111113`  — active tab pills, selected calendar-style items,
                          primary emphasis chips; white text on it
- ROYAL (brand accent)   `#3457D5`  — primary buttons + links ONLY, used sparingly
                          (selection is black's job, per the reference)
- GREEN (positive)       `#2E9E5B`  text-grade on white (deltas, health, success)
- Red (danger)           `#D4524A` · Amber (warn) `#B8860B`-adjacent `#B98A2E` — text-grade
- Chart lines on white   royal `#3457D5` → green `#2E9E5B` → slate `#7C8DB0` → warm gray
                          `#8E8B87` → muted amber `#B98A2E`

## Pastel tints (the reference's signature — category language)
Low-saturation washes used as CHIP and EVENT-CARD backgrounds with DARK text (never white):
- Lavender `#ECEBFA` (agents/AI) · Mint `#DFF3E6` (success/present/money-in)
- Peach `#FBEBDD` (warnings/edits) · Sky `#DDEBF9` (messages/views/info)
- Rose `#F9E3E1` (errors/absence) · Butter `#FBF3D9` (pending/scheduled)
Rule: tints are BACKGROUNDS at this wash level only; the saturated hue never appears as
text/fill. Icon inside a tinted chip may use a darker same-hue tone (e.g. lavender chip,
`#5B54C7` icon). This REPLACES v1's "no coloured card backgrounds" ban — soft tints ARE the
aesthetic; SATURATED backgrounds remain banned.

## Geometry & materials
- Radii: cards 16px · controls 12px · pills 999px (the reference is pill-heavy — tabs,
  day-selectors, filter buttons are pills)
- Hairlines `#E5E5EA`; shadows soft/large-radius/low-alpha (see Surface); no glass blur on
  light — flat white surfaces with shadow depth instead
- Icons: thin-stroke (1.5-1.8px), `#1D1D1F` or secondary gray

## Typography
- Stack unchanged: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Inter, system-ui`
- Tracking `-0.02em` ≥28px; numbers ALWAYS `tnum`; hierarchy via weight + gray-scale, not colour

## Numbers first (owner rule — unchanged from v1)
Metrics are read as NUMBERS: dense stat tiles (big `tnum` value · quiet label · delta chip,
green up-good / red down-bad), 10–16 per section is good; charts ONLY behind per-tile/group
expand; sparkline hints ≤48px, axis-less. Heatmaps/donuts render as ranked number lists with
the visual behind the expand. Tables/leaderboards stay.

## Motion
200–260ms `cubic-bezier(0.32, 0.72, 0, 1)`; hover = shadow lift + hairline darken;
`prefers-reduced-motion` kills all of it.

## Bans
Bright/saturated anything (neon, vivid purple/orange/pink), dark-glass surfaces on the light
canvas, white text on pastel tints, more than ONE black pill cluster + royal accent per view,
gradients except the hero number (near-black `#1D1D1F` → royal `#3457D5`, subtle).

## Dark mode
Out of scope for now — light-first per the owner reference. The token architecture (all
colour through ui.ts COLORS + globals vars) keeps a future dark toggle cheap.
