# CONTEXT

Domain glossary for **catchup** — the static site that visualizes what happened across the
Lascade org each day. Terms here are the canonical vocabulary the UI and data files share.

## Glossary

- **Day** — a single date's activity, stored as one `daily/<YYYY-MM-DD>.json`. The unit the
  calendar navigates and the feed renders. The date is the identity; it appears in the file
  path, the file's `date` field, and the URL hash (`#2026-05-26`).

- **Repo** — a `Lascade-Co/*` repository. A **filter facet** (multi-select dropdown) and the
  default grouping key for the feed.

- **Developer** (a.k.a. **User**) — a contributor to a repo on a given day, identified by GitHub
  `login`. When `login` is `null` (commit not attributed to a GitHub account), the contributor
  is keyed by `name` instead (`name:<name>`). A **filter facet** (chips) and the alternate
  grouping key. Identity is the raw login — near-duplicate logins (e.g. `Mushf1qHumayoon` vs
  `MushfiqHumayoon`) are treated as distinct people, not merged. Rendered with the developer's
  GitHub profile picture (`https://github.com/<login>.png`, falling back to a colored-initials
  avatar when `login` is `null` or the image fails) and linked to their GitHub profile.

- **Bullet** — a pre-generated, emoji-prefixed, human-readable summary of one developer's work
  in one repo on one day. The leading emoji encodes commit type (🚀 feature, 🐛 fix, ♻️ refactor,
  ⚡ perf, 📝 docs, 🔧 chore, 💄/🎨 UI, 🧹 cleanup, 📊/📉 analysis). Rendered verbatim; never
  generated or rewritten client-side. `commit_count` is independent of the number of bullets.
  Bullets are grouped by **Status** (see below): `developers[].bullets` is an object keyed by
  status, not a flat array.

- **Status** — the lifecycle bucket a bullet belongs to: `Published`, `Testing`, or
  `Work in Progress`. The keys of the `bullets` object. The feed renders statuses in the fixed
  order Published → Testing → Work in Progress, with any unrecognized status appended after in
  encounter order.

- **PR** — a pull request touched in a repo on a given day: `{ number, title, author }`. Rendered
  as the linked title (→ `github.com/<repo>/pull/<number>`); the repo view also shows a linked
  `@author`, the developer view shows only the viewed developer's own PRs.

- **Branch** — an active branch name in a repo (`branches` field). Present in the data but not
  rendered in the UI.

- **Version** — a repo's release/version string, or `null`. Shown as a badge beside the repo
  name when present.

- **Activity feed** — the main region of the page listing the viewed day's activity, grouped
  either by **repo** or by **developer**. Grouped by repo, a section shows the repo's bullets
  organized by status (each bullet attributed to its developer), then PRs, version, and a commit
  breakdown rendered as compact chips (avatar + name + count). Grouped by developer, a section lists the repos
  (by repo name only) the developer touched, each with bullets by status and the developer's own
  PRs.

- **Filter facet** — the two filter dimensions: **repos** (multi-select dropdown) and **users**
  (chips). Combined as **repo AND user** across facets, **OR within** a facet; an empty facet
  imposes no constraint. The facet vocabularies come from `index.json` (`repos`, `users`), not
  from the viewed day. Selected filters persist in `localStorage`; selections absent from the
  viewed day stay active and simply produce no matches.

## Data files

- **`index.json`** — manifest: `{ daily: [paths], repos: [string], users: [{login, name}] }`.
  `daily` paths drive the calendar's available days; `repos`/`users` drive the filter facets.
- **`daily/<date>.json`** — `{ date, repos: [{ repo, developers: [{ login, name, commit_count,
  bullets: { <Status>: [string] } }], prs: [{ number, title, author }], branches: [string],
  version: string | null }] }`.

These files are produced upstream (the `Lascade-Co/actions` daily catchup workflow). This repo
stores and visualizes them; it does not generate them.
