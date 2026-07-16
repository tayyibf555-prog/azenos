# Azen OS Design System v3 — "Soft Light, Dense" (lead-pinned 2026-07-17)

Owner verdict on the v2 app: too empty/oversized, inconsistent screen-to-screen, bland vs the
reference, structure not working. Root cause: three theme passes recoloured screens that were
never DESIGNED as one product. This spec fixes the bones. Palette/tints stay APPLE-THEME.md v2
(Soft Light); this document governs LAYOUT, DENSITY, COMPONENTS, ICONOGRAPHY. Where the two
conflict, THIS file wins. The reference screenshot (Techerly-style light dashboard) is the
density + polish benchmark.

## 1 · Density scale (the #1 fix — everything shrinks and tightens)
- Type: page title 20px/650 · section title 15px/620 · card title 13.5px/600 · body 13px ·
  secondary 12px · micro 11px · HERO numbers 22–26px tnum (NEVER 34px+) · stat values 18–20px
- Spacing: page outer padding 24px · grid gaps 12–14px · card padding 14–16px · list rows
  40–44px tall · sidebar rows 34px · control height 32px (pills/buttons/inputs)
- Rule: NO card whose content fills <50% of its area. A single number NEVER gets its own
  giant card — stats live in COMPACT TILE ROWS (label 12px muted over value 18–20px tnum +
  delta chip), 4–6 across on desktop.
- Radius: cards 14 · squircles 10 · controls/pills 999 · inputs 10

## 2 · App shell
- SIDEBAR (232px, white, hairline right): brand row (28px logo square) → ⌘K search-style "Ask"
  field (32px, gray fill #F2F2F7, ⌘K kbd right) → section label ("MAIN MENU" 11px/500 uppercase
  #AEAEB2) → nav rows: 34px, 16px thin icon, 13.5px label; ACTIVE = black pill (#111113, white
  text, full-row); hover = #F2F2F7 fill → second section ("WORKSPACE") for Portfolio/Health/
  Growth/Learn → pinned FOOTER: shortcuts mini-card, then AVATAR ROW (28px initials circle in
  a pastel tint · name 13px/600 · role 11.5px muted) like the reference's teacher footer.
- TOPBAR (every page, 56px, white, hairline bottom): BREADCRUMBS left (13px: section icon ·
  parent muted · chevron #C7C7CC · current 600) · right cluster: icon buttons 32px circular
  (search, notifications w/ 6px royal dot when relevant) + the Live/env chip.
- CANVAS: #F2F2F7, max-width 1280 centered, 24px padding.

## 3 · The signature: tinted icon squircles (the reference's life — use EVERYWHERE)
32px (28px in dense lists), radius 10, PASTEL TINT bg + 16px SAME-HUE DARKER icon:
- lavender #ECEBFA / icon #5B54C7 → AI, agents, LLM events
- mint     #DFF3E6 / icon #1F7A43 → success, money-in, bookings-completed, present
- sky      #DDEBF9 / icon #2B6CB0 → messages, views, info, sessions
- peach    #FBEBDD / icon #B05C2A → edits, warnings, pending-attention
- rose     #F9E3E1 / icon #B0433A → errors, absence, failures
- butter   #FBF3D9 / icon #8A6D1B → scheduled, waiting, invoices
- graphite #ECECF1 / icon #3A3A3C → system, misc
Every event chip, list row, stat group header, nav-less card gets one. This kills the blandness.

## 4 · Component library (components/system/* — screens may ONLY compose these)
- `PageShell` topbar+breadcrumbs+canvas wrapper · `SectionHeader` (title 15px + right actions)
- `StatRow`/`StatCell` compact KPI strip (the ONLY way stats render; hero variant 24px max)
- `IconSquircle` (§3) · `EventChip` tinted card: squircle + title 13px/600 + time 11.5px muted,
  32–36px tall — ticker, activity, calendars all use it
- `ListRow` 44px: squircle/avatar · primary 13.5px + secondary 12px muted · right meta/pill ·
  hairline separators, hover #FAFAFC
- `Pill` (black active / gray) · `CountdownPill` tinted ("2 days left") · `StatusDot+Label`
- `MiniCalendar` month grid, 28px day cells, black selected circle, tint dots for events
- `DataCard` white card 14px pad w/ optional squircle header · `Avatar` initials in tint
- `KbdChip` · `EmptyState` (dashed, 12px, one line + one action — never a giant void)
Existing StatTile/StatGrid/ExpandableChart get restyled to §1 sizes and REUSED inside these.

## 5 · Structure per screen archetype
- DASHBOARDS (Command Center, Health, Portfolio): topbar → one compact StatRow (4–6 cells) →
  2-col grid (main 2fr / rail 1fr): main = dense DataCards (lists, tables, quadrant), rail =
  MiniCalendar / upcoming (EventChips w/ CountdownPills) / alerts. Reference layout, literally.
- DETAIL (project/client): topbar breadcrumbs → compact header row (name 20px, dots, pills,
  actions right, 44px total) → black-pill tab row → content grid at §1 density.
- ANALYTICS: keep the left rail but §1 density (rows 40px, 13px labels); numbers-first tiles
  at StatCell sizes; charts stay behind expand.
- FULL-BLEED LISTS (bookings, briefs, clients): toolbar (search 32px + filter pills) →
  ListRows, NOT cards-per-item.

## 6 · Consistency contract
One header pattern, one tab pattern (black pills), one list pattern, one stat pattern, one
empty-state — ZERO per-screen inventions. Any screen element not expressible via §4 components
is a spec gap: escalate, don't improvise. Numbers-first rule unchanged. Motion/AA per v2.

## 7 · Rollout
Phase A (DONE when approved): components/system/* + Command Center rebuilt as the living
template → owner screenshot approval. Phase B: fleet applies §5 archetypes to every screen,
browser-verified per screen against THIS file. No screen ships off-system.
