# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

This repo is a **static site hosted on GitHub Pages** that visualizes what happened across the Lascade organization each day. The data is committed as JSON; the front end reads it client-side. There is no build step or server — `index.html` plus JS/CSS load and render the JSON directly via `fetch`.

## Data model

Everything renders from two layers of JSON, both fetched relative to the site root:

- **`index.json`** — the manifest. `{ "daily": ["daily/<date>.json", ...] }`. An array of paths to daily files, newest entries appended. This is the entry point the front end fetches first to discover available days.
- **`daily/<YYYY-MM-DD>.json`** — one file per day. Shape:
  ```json
  {
    "date": "2026-05-26",
    "repos": [
      {
        "repo": "Lascade-Co/<name>",
        "developers": [
          {
            "login": "github-login-or-null",
            "name": "Display Name",
            "commit_count": 6,
            "bullets": ["🚀 ...", "🐛 ..."]
          }
        ]
      }
    ]
  }
  ```

Notes that affect rendering logic:
- `developers[].login` can be `null` (commits not attributed to a GitHub account) — fall back to `name`.
- The same person may appear under multiple `login`/`name` casings across repos (e.g. `Mushf1qHumayoon` vs `MushfiqHumayoon`); treat logins as the identity key but don't assume they're normalized.
- `bullets` are pre-generated human-readable summaries prefixed with an emoji that encodes commit type (🚀 feature, 🐛 fix, ♻️ refactor, ⚡ perf, 📝 docs, 🔧 chore, 💄/🎨 UI, 🧹 cleanup, 📊/📉 analysis). `commit_count` is independent of bullet count.

Daily JSON files are produced upstream by the `Lascade-Co/actions` daily catchup workflow — this repo only stores and visualizes them; it does not generate them.

## Conventions

- Keep the front end **dependency-free static files** (vanilla HTML/JS/CSS or CDN-loaded libs) so GitHub Pages serves it without a build. Paths must be relative for the project-pages subpath to work.
- When adding a new day, write `daily/<date>.json` and append its path to `index.json`.