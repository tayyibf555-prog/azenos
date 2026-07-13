# Data processing note — template (spec §16)

> Attach to client contracts. Plain-English summary of what Azen OS receives
> from a client system and how it is handled. Not legal advice — have a
> solicitor review before first client use.

**What we collect.** Your system sends Azen AI operational events (bookings
made, conversations handled, payments recorded, system errors) over an
encrypted, signed webhook. By default these are summaries and metadata — not
full conversation transcripts. Where a person is referenced, we receive the
minimum needed to report to you (e.g. a first name and booking time).

**What we do with it.** The data powers your monthly value reports, system
health monitoring, and recommendations we make to you. Aggregate, anonymised
patterns (e.g. "recall reminders recover X% of lapsed patients") may inform
our industry knowledge base; nothing client-identifiable is ever shared.

**Retention.** Raw events are kept for 24 months, aggregated statistics
indefinitely. You can request deletion of a specific person's events at any
time and we will comply within [N] days (default: promptly, typically under
one week).

**Options.** At your request we can mask personal fields at the point of
ingestion (hashed identifiers, no emails/phones stored) — ask and we will
enable it for your project.

**Security.** Webhooks are authenticated with per-project signed secrets;
data is stored in [region] with access limited to Azen AI.
