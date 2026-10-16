# Local-time fix (2026-10-15)

## Problem

User in CST (UTC+8) noticed every "session time" is 8 hours behind their
local clock. Root cause: every layer was writing/displaying UTC ISO (`...Z`).

| Source | Was | Wanted |
|---|---|---|
| `~/.pi/agent/decisions.jsonl` `timestamp` | UTC ISO `...Z` | also local `YYYY-MM-DD HH:MM:SS+08:00` |
| Footer (main line) | `耗时 2m 56s` only | also `开始于 HH:MM:SS+08:00` |
| Footer (hover panel) | relative | also absolute local start |
| pi-webui session list | `mtime · size` only | also `开始于 localTime` from session header |

The session JSONL `timestamp` field itself can't be changed without
patching Pi (forbidden by AGENTS.md §1 "No Pi patches"). Instead we let
Pi keep UTC, but always render with local TZ everywhere we control.

## Files changed

| File | Change |
|---|---|
| `extensions/shared/journal.ts` | `+formatLocalTime(Date)` pure helper · each journal entry gets `localTime` alongside UTC `timestamp` |
| `extensions/footer-override/index.ts` | `+formatClockLocal(Date)` and `+formatTzOffset(Date)` pure helpers · footer main line shows `开始于 HH:MM:SS+08:00` · hover panel meta line shows `开始 HH:MM:SS+08:00` |
| `extensions/tests/journal-local-time.test.ts` | NEW: 4 tests for `formatLocalTime` + integration into journal writes |
| `extensions/tests/footer-clock.test.ts` | NEW: 5 tests for `formatClockLocal` and `formatTzOffset` |
| `D:/PI/pi-webui/server.js` | `+formatLocalTime(d)` and `+formatTzOffset(d)` helpers · session info gets `localTime` and `tzOffset` from session header `timestamp` |
| `D:/PI/pi-webui/public/app.js` | `+fmtSessionStart(s)` and `+fmtLocalClock(d)` · session-list meta now shows `开始于 YYYY-MM-DD HH:MM:SS+08:00 · X 分钟前 · KB` |

## Test results

```
tests 106
pass 106
fail 0
```

(97 pre-existing + 4 journal + 5 footer-clock = 106)

`footer-override/index.ts:451` `ThemeBg` type error and
`footer-override.test.ts` `registerEntryRenderer` mock gap are pre-existing,
unrelated to this fix.

## Live verification

After the patch, writing to the live journal produced:

```json
{
  "timestamp":"2026-10-15T07:40:14.899Z",
  "localTime":"2026-10-15 15:40:14+08:00",
  "kind":"config_loaded",
  "config":{"test":"local-time-fix-2026-10-15"}
}
```

07:40 UTC = 15:40 CST (correct 8h shift). Both representations live in the
file so downstream consumers can pick whichever they prefer; tools that
need UTC keep working unchanged.

## Notes for the user

- The session JSONL files (under `D:/PI/pi-webui/sessions/`) still have
  UTC ISO in their `timestamp` field — that's set by Pi, and the AGENTS.md
  "No Pi patches" rule prevents changing it. pi-webui now converts to
  local before display, so the web UI will show local times.
- The session file NAMES still include `Z` (e.g.
  `2026-10-15T07-15-55-048Z_*.jsonl`) — that's also from Pi. Sorting
  by name still gives UTC order. If you want file-listing order to match
  local time, rename the files, or use the web UI's `dayBucket` grouping
  which already uses local mtime.
- The footer now shows BOTH `开始于 HH:MM:SS+08:00` (absolute local) and
  `耗时 Xm Ys` (duration) so you don't have to subtract anything.