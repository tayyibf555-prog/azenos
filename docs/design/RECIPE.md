<!-- BINDING: this file wins over DESIGN-SYSTEM.md and APPLE-THEME.md wherever they conflict.
     Produced 2026-07-17 by the 74-brand match against the owner's reference image.
     Top 5: Wise, Notion, Miro, Starbucks, Shopify (+ Figma runner-up). -->

THE RECIPE — a binding aesthetic spec to recreate the reference (soft light education dashboard) for Azen's business OS. All choices cited to source brand. No fluff.

---

# AZEN DASHBOARD RECIPE — "Soft Consumer Light"

## 1) THE TOP 5 (ranked — what each contributes)

1. **Wise** — the literal T1 mechanism: a *tinted* canvas (`#e8ebe6` sage) behind **pure-white borderless cards** where *surface contrast, not a hairline, is the elevation*. Steal the recipe, swap sage→neutral gray. Also the canonical **24px** card/button radius (T2).
2. **Notion** — the complete **T4 pastel container palette**: six named tints (peach/rose/mint/lavender/sky/yellow) used as *whole feature-card backgrounds* with dark charcoal text and zero border. This is the exact "color = category on content" system Azen needs.
3. **Miro** — **T3 discipline** applied to chrome: black pill is the *only* strong CTA/active color, brand hue confined to logo; pastel cards at **28px** radius; `{rounded.full}` on *every* button/tab/badge with no exceptions.
4. **Starbucks** — the **borderless-card shadow formula** (`0 0 0.5px rgba(0,0,0,.14), 0 1px 1px rgba(0,0,0,.24)`) that separates cards *without* a hairline (T1), plus the **50px full-pill** universal button + `scale(0.95)` press, and the **circular floating/icon** language (T6).
5. **Shopify** — the **featured-tile-as-mint-fill** move (highlight by *tinting the whole container*, not by a colored border) and pill-only button shape — reinforces T4's "wash the container" over chrome accents.

*(Runner-up: **Figma** — pill-is-the-only-shape mandate (`rounded.pill 50px` text CTAs, `rounded.full` icons) and black = selected-state = same surface as primary; use as the tab/toggle rule.)*

---

## 2) TOKENS (exact)

### Canvas & surface (Wise mechanism + Starbucks shadow)
```
--bg:            #F1F2F4;   /* soft neutral-gray canvas (reference ~#F1F2F4). NOT pure white, NOT Apple #F2F2F7-cold */
--bg-well:       #EAEBEE;   /* deeper inset wells / section grooves */
--card:          #FFFFFF;   /* PURE white cards */
--card-border:   none;      /* T1: NO hairline. Separation = bg contrast + shadow ONLY */
```
Card shadow (Starbucks whisper-double, tuned slightly softer/wider for dashboard scale):
```
--shadow-card:   0 0 0.5px rgba(20,22,26,.06), 0 1px 2px rgba(20,22,26,.05), 0 6px 16px -6px rgba(20,22,26,.06);
--shadow-hover:  0 0 0.5px rgba(20,22,26,.08), 0 2px 4px rgba(20,22,26,.06), 0 12px 28px -8px rgba(20,22,26,.10);
--shadow-pop:    0 8px 20px -6px rgba(20,22,26,.10), 0 30px 60px -20px rgba(20,22,26,.22);  /* palette/modal */
```

### Radius (Miro/Mastercard three-tier — skip the 8–12 middle, commit to pill-or-large)
```
--radius-frame:  28px;   /* the app frame / outer shell — reference frames the whole app (Mastercard hero-tier 40, Miro feature 32; 28 fits a dense dashboard) */
--radius-card:   20px;   /* content cards (Notion xxl 20 / Wise xl 24) */
--radius-tile:   16px;   /* nested tiles, tinted event cards (Miro card-base 16) */
--radius-pill:   9999px; /* EVERY interactive element: button, tab, filter, chip, badge (Figma/Miro/Uber/Ollama mandate) */
--radius-icon:   12px;   /* the WHITE icon-holder square inside a tinted card (rounded-square, per reference) */
--radius-circle: 50%;    /* avatars, icon buttons, calendar day cells (T6) */
```

### The one strong accent (Miro/Figma/Uber — black is the ONLY structural saturated color)
```
--ink:           #14140F;  /* warm near-black (Mastercard #141413 / Miro #1c1c1e) — text + the lone accent */
--pill-active:   #14140F;  /* active tab, selected day, active month, primary CTA fill — black */
--on-pill:       #FFFFFF;
```
**Rule (T3):** black is the *only* strong fill anywhere in the chrome. No royal blue, no gradient, no brand hue used structurally. A brand hue may exist in the logo only. Every other control at rest is neutral gray on white.

### Neutral text ladder (Notion warm-charcoal family — reads friendlier than cold Apple grays)
```
--text:    #37352F;  /* Notion charcoal — primary (warmer than #1d1d1f) */
--text-2:  #6B6A65;  /* secondary labels, axis */
--text-3:  #9B9A94;  /* captions, placeholders */
```

### The 6 pastel container tints (Notion palette — ~10–15% sat washes)
Each is a **whole-card background**, holding a **white rounded-square icon holder** + **deep-hue text**. Countdown/status pill inside sits in a **deeper wash** of the same hue.

| Tone | Card wash (Notion) | White icon holder | Deep text/icon | Status pill (deeper wash) | Category |
|---|---|---|---|---|---|
| lavender | `#E6E0F5` | `#FFFFFF` | `#4A3A82` | `#D6C9F0` | AI / agents / LLM |
| mint | `#D9F3E1` | `#FFFFFF` | `#1F7A43` | `#C3EBD0` | money-in / bookings / success |
| sky | `#DCECFA` | `#FFFFFF` | `#255E9E` | `#C7DFF5` | messages / views / sessions |
| peach | `#FFE8D4` | `#FFFFFF` | `#9E5320` | `#FBD9BE` | edits / pending / attention |
| rose | `#FDE0EC` | `#FFFFFF` | `#A83464` | `#F9CDDE` | errors / churn / failures |
| butter | `#FEF7D6` | `#FFFFFF` | `#8A6D1B` | `#F7EBB4` | scheduled / waiting / invoices |
| graphite* | `#F0EEEC` | `#FFFFFF` | `#3A3A3C` | `#E4E1DE` | system / misc (neutral member) |

*(graphite = the neutral 7th, Notion `card-tint-gray`.) Icon-holder shadow: `0 1px 2px rgba(0,0,0,.06)`. **Cycle-different-tint-per-adjacent-card** (Clay rule) so no two neighbors repeat.*

### Type scale (Notion/Miro friendly-SaaS — medium weights, relaxed tracking, 12–14 UI)
Family: keep SF Pro / Inter stack. **Loosen the tracking** — the reference is friendly, not editorial-tight.
```
--display:   28px / 600 / -0.5px    (hero stat headline; Notion heading-3)
--h2:        20px / 600 / -0.3px    (card titles)
--h3:        16px / 600 / -0.2px    (section labels)
--body:      14px / 400 / 0         (default — Notion body leading 1.5)
--body-med:  14px / 500 / 0         (emphasis, active nav label)
--ui:        13px / 500 / 0         (buttons, tabs, chips)
--caption:   12px / 500 / 0         (metadata, countdown pills)
--micro-caps:11px / 600 / +0.4px    (eyebrow/section dividers only)
```
Weights: **400 body / 500 medium / 600 heading**. No 700, no ≤-0.28em display tracking. (Reference = medium-weight consumer warmth, not Apple's tight -0.028em.)

### Spacing (Notion/Miro 4px base — airy INSIDE, compact BETWEEN per T5)
```
xs 4 · sm 8 · md 12 · lg 16 · xl 20 · 2xl 24 · 3xl 32
Card interior padding: 20–24px (airy inside).
Gap between cards: 12–16px (compact between).
Sidebar width: 232px (keep).
```

---

## 3) COMPONENT TREATMENTS

### Sidebar (Wise `ex-app-shell-row` + Starbucks white active, NOT black)
- White rail (`--card`), **no right hairline** — let the gray canvas meet the white rail as the divider (T1). If separation is weak, use a single soft shadow `2px 0 12px -6px rgba(0,0,0,.05)`, never a 1px line.
- **Two labelled sections** with `--micro-caps` gray headers (T7).
- Thin-line icons, `--body-med` labels, `--text-2` at rest.
- **Active row = softly ELEVATED WHITE pill** (`--radius-pill` or 12–14px), `background:#FFFFFF`, `box-shadow:--shadow-card`, text→`--text`, tiny `--pill-active` left accent dot optional. **This is the reference's Cal.com "inset white active-segment pill + subtle shadow" mechanism.** Black is NOT used here.
- Footer: circular avatar + name + role (`--text-3`).

### Breadcrumb topbar + circular icon buttons (Miro/Figma T6)
- Breadcrumb: small tinted icon + label + chevron (`--text-3`) segments; current unlinked.
- Icon buttons: **circular** `36–40px`, `background:#FFFFFF`, thin-line icon, `--shadow-card`; **no border**. Notification dot = 8px filled circle in the tone's deep-hue, top-right.
- Search: full **pill** (`--radius-pill`), `--bg-well` fill, no border.

### Tinted event/content cards (Notion `card-feature-*` + reference's white-icon-holder)
- Whole card = one tint wash from the table, `--radius-tile` (16px), **zero border**, no shadow (the wash *is* the separation from white siblings — Figma/Notion principle).
- Top-left: **white rounded-square icon holder** (`--radius-icon` 12px, `#FFFFFF`, icon in deep-hue, `0 1px 2px rgba(0,0,0,.06)`).
- Title in deep-hue text; body in a muted deep-hue.
- Countdown/meta = **pill in the deeper-wash** of the same hue (Wise `badge-positive` mechanism — deeper wash of parent hue, `--caption`).

### Mini-calendar (reference circles + Miro black)
- Day cells = **circles** (`50%`). Default transparent, `--text` numeral.
- **Selected day = filled `--pill-active` black circle**, white numeral. Today = thin `--text` ring.
- Active month control = **black pill** (`--pill-active`) — the *one* place besides selected-day that black appears in content (T3).
- Weekday headers `--micro-caps` gray.

### Stat presentation (softer than dev-tool — Notion `stat-row` on tinted well)
- Stat lives in a **white card** or a **tinted mini-card**, never a bare bordered box.
- Big number in `--display` (28/600), label above in `--micro-caps` gray, delta as a **mint/rose pill** (deeper-wash), sparkline in the tone's deep-hue.
- No gridlines-heavy chart chrome; airy, single soft baseline.

### List rows without hairlines (Wise/Starbucks — whitespace + zebra, not lines)
- Rows separated by **spacing + optional `--bg-well` zebra**, never a 1px divider.
- Row hover = `--bg-well` fill at `--radius-tile`, no border.
- Leading circular avatar/icon (T6); trailing status = pill.

### Buttons (Figma/Starbucks/Uber — pill mandate)
- **All buttons = `--radius-pill`.** Primary = **black fill** (`--pill-active`) + white text (T3 — replaces royal-blue gradient). Secondary = `--bg-well` gray pill, `--text`. Tertiary = ghost pill. `scale(0.97)` active (Starbucks).
- No gradients anywhere.

---

## 4) WHAT AZEN CURRENTLY GETS WRONG (exact deltas vs this recipe)

Read against `apps/web/app/globals.css` `:root` and `components/system/tokens.ts`:

1. **Cards carry a visible hairline — breaks T1.** `.card { border: 1px solid var(--border) }` (globals.css L208) with `--glass-border:#e5e5ea` (L22). The reference has *no* hairline; separation is bg-contrast + shadow (Wise/Starbucks). **Fix:** drop the border on `.card`, `.glass-strong`, inputs at rest; lean on `--shadow-card`. Applies to L208, L245, and every `border:1px solid var(--border)` container.

2. **Radii too small / not pills — breaks T2.** `--radius:16px`, `--radius-sm:12px` (L66-67); buttons use `--radius-sm` 12px (L401), `.nav-item` 10px (L355), `.tab` 10px (L608). The reference is pill-or-large: **buttons/tabs/filters must be `9999px`**, cards should go **20px**, and there's no app-frame radius token at all. **Fix:** add `--radius-frame:28px`, raise `--radius-card:20px`, set all interactive controls to `--radius-pill`. Current buttons at 12px read enterprise, not consumer.

3. **Tints are icon-square holders, not whole containers — breaks T4.** `TINTS` in tokens.ts (L19-27) pairs `{bg,fg}` used as small *squircle icon backers* (`SquircleTone`), while cards stay white. The reference tints the **entire content card** (Notion `card-feature-*`) with a **white icon holder inside**. **Fix:** invert the model — the *card* takes `TINTS[tone].bg`, and add a `#FFFFFF` icon holder + a deeper-wash status pill per tone. Add the `pill`/`deepWash` values (table in §2) to each `TINTS` entry.

4. **Black pill overused in the sidebar — breaks T3/T7.** `.nav-item-active { background: var(--black-pill) }` (globals.css L372-374) and `.tab.active` → black (L622). The reference's sidebar active row is a **softly elevated WHITE pill**; black is reserved for the *calendar* selected-day/active-month only. **Fix:** active nav = white + `--shadow-card` + `--text` (Cal.com mechanism); keep black exclusively for calendar selection and the single primary CTA.

5. **Royal-blue gradient primary + hero gradient — breaks T3.** `--accent:#3457d5` drives `.btn-primary { background: linear-gradient(180deg,#3d61e0,var(--accent)) }` (L440-446) and `.accent-num` text gradient (L389). The reference has **no saturated structural color and no gradients** — black is the only strong accent. **Fix:** primary button → flat black pill; delete the accent-num gradient (use `--text`); demote `--accent` to at most a link color, never a fill.

6. **Type too tight/austere — softens T5.** Headings at `letter-spacing:-0.02em`, h1 `-0.028em/620` (globals.css L131-138), base 14px with `cv01/ss01`. The reference is friendly medium-weight, relaxed tracking. **Fix:** headings to `-0.3 to -0.5px` max, weight 600 (not 620), keep body 14/400 but adopt the warmer **Notion charcoal `#37352F`** for `--text` instead of cold `#1d1d1f`.

7. **Cold canvas vs warm-neutral.** `--bg:#f2f2f7` (Apple systemGray6, cool) vs reference `~#F1F2F4`. Minor but real — nudge to the neutral `#F1F2F4` and add `--bg-well:#EAEBEE` for wells/zebra so list rows can drop their hairlines (delta #1).

8. **Inputs/buttons default to bordered gray, not pill wells.** `.btn { border:1px solid var(--border-2); --radius-sm }` (L400-401), inputs `border:1px solid var(--border-2)` (L478). Reference secondary controls are **borderless gray pills** (Uber `button-subtle #efefef`). **Fix:** secondary button = `--bg-well` fill, pill, no border; input = `--bg-well` fill, `--radius-tile`, no rest border, focus adds a soft ring not a hairline.

**Net:** Azen is ~70% there (light canvas, white cards, pastel vocabulary, black-selection instinct all exist) but reads *enterprise-dev* because of (a) hairline borders everywhere, (b) 10–12px radii instead of pills, (c) tints shrunk to icon chips, and (d) royal-blue gradients competing with black. Removing borders, committing to pills, tinting whole cards, and making black the sole accent converts it to the reference's friendly consumer-SaaS language.