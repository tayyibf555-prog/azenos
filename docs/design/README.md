# Design references (vendored)

Source: https://github.com/VoltAgent/awesome-design-md (`main`, fetched 2026-07-16).
Only the brand systems relevant to Azen OS's direction are vendored (raw-file fetch,
no clone — disk-light per docs/DECISIONS.md).

Azen OS direction — **"Quiet Glass"**: near-black base, dark royal blue `#3f6bff`
primary, cyan-teal `#22cadb` highlight, frosted-glass surfaces (liquid morphism),
tabular numbers, one accent gradient number per view, semantic-only status colours.
Tokens live in `apps/web/app/globals.css` + `apps/web/components/ui.ts` (COLORS).

| File | Why it's here |
|---|---|
| `apple.md` | Liquid-glass materials, depth, motion physics, restraint |
| `linear.app.md` | THE dark dashboard reference — density with calm, royal-blue accents |
| `raycast.md` | Dark glass panels, command-palette chrome (matches our ⌘K Ask) |
| `cursor.md` | Dark dev-tool surfaces, quiet hierarchy |
| `vercel.md` | Black-first minimalism, typographic discipline |
| `stripe.md` | Data-dense finance UI done tastefully (Money screens) |
| `framer.md` | Gradient accents on dark without noise |
| `elevenlabs.md` | Modern dark AI-product chrome |

Rule for agents: these are REFERENCE ONLY — extract principles (spacing, hierarchy,
material treatments), never copy a brand's identity. All colour comes from ui.ts COLORS.
