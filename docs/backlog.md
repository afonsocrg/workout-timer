# Backlog

Ideas to spec before building. Each entry: what it is, why, and the open
questions to settle first. Move an item out (and into the decision log) once
it's decided and built.

---

## Post-workout effort feedback

**Idea.** When a workout finishes, ask for a quick rating of how it went in
terms of effort, and keep it with that run in the log.

**Why.** Track how hard sessions felt over time, not just that they happened.

**Open questions.**
- Scale: RPE 1–10, a 1–5 scale, or a few labels (easy / ok / hard / max)?
- Required, skippable, or editable later from the Log?
- Effort only, or also a short free-text note?
- Where it shows: Log entries, the Home calendar (e.g. colour by effort)?
- Data model: a new optional field on log entries — needs a schema version
  bump and a migration (see [data model](data-model.md)).
