# DevPilotAI Interactive Elements Audit

## Audit Scope
All buttons, links, dropdowns, toggles, inputs, and clickable elements across:
- `apps/web/src/pages/`: 7 page files
- `apps/web/src/components/`: 23 component files

## Agent Results Summary

### Agent 1: Security Audit (OWASP-style)
**Status:** Completed — 14 Blockers, 9 Warnings, 12 Suggestions

**Blockers (14 found):**
- CliToolsPage.tsx:3 races on disable/enable/check buttons (double-submission)
- SessionsPage.tsx:2 `stopSession`/`runAction` global `actionId` race conditions
- TerminalsPage.tsx:5 `runTerminalAction`/`stopSession`/`startAllTerminals`/`deleteSession`/`addTerminal` race conditions; `closeTerminal` inconsistent state
- ProjectsPage.tsx:3 dialog-opening buttons without double-click guards
- TerminalsPage.tsx:advanced panel toggle missing `aria-expanded`/`aria-controls`

**Warnings (9 found):**
- CliToolsPage.tsx:3 error handling doesn't distinguish error types; generic messages
- SessionsPage.tsx:1 auto-refresh interval could pause on tab hidden; refresh button `void load()` pattern
- TerminalsPage.tsx:4 `closeTerminal` inconsistent state on stop failure; `resizeSplit` silent failure; toolbar prop usage
- ProjectsPage.tsx:1 search input no client-side length validation
- OverviewPage.tsx:1 duplicate "New session" buttons without disabled state

**Suggestions (12 found):**
- Consistent loading button patterns across all pages
- Auto-dismiss toasts after 5-10s
- Replace `window.confirm()` with accessible modals
- Relative time displays for timestamps
- Character counters on textareas
- Relative time for "last checked" timestamps
- Extract duplicate "New session" code
- Relative time formatting improvements

---

### Agent 2: No-Hardcoding Audit
**Status:** Completed — 0 Blockers, 4 Warnings, 30+ Suggestions

**Warnings (4 found):**
- SessionsPage.tsx:62 — `5000` polling interval ms should be configurable
- TerminalsPage.tsx:662 — `maxLength={4000}` on textarea should be named constant
- TerminalsPage.tsx:93-95 — Already uses `LIVE_POLL_INTERVAL_MS` constant (OK)
- ProjectsPage.tsx:60 — `250` debounce ms should be configurable

**Suggestions (30+ found):**
- Centralize all `/api/*` endpoints in `src/lib/api.ts` or route constants
- Extract user-facing confirm/error messages to `src/lib/messages.ts`
- Move `5000` polling interval and `250` debounce to `src/lib/constants.ts`
- Move `4000` maxLength to constants or type definition
- Remove hardcoded `127.0.0.1` from SettingsPage — fetch from backend health
- Hardcoded API endpoints in all 7 page files (30+ occurrences)
- Hardcoded user-facing strings in confirm/alert/error messages (30+ occurrences)
- Inline config candidates: bind IP, debounce values, maxLength

---

### Agent 3: Readability Audit
**Status:** Completed — 3 Blockers, 15 Warnings, 10 Suggestions

**Blockers (3 found — files >100 lines doing too many things):**
- `TerminalSplitView.tsx` (678 lines) — layout calc + pointer/resize + keyboard + DOM
- `TerminalPanel.tsx` (678 lines) — Terminal + WebSocket + ResizeObserver + DOM in one `useEffect`
- `NewSessionDialog.tsx` (675 lines) — form state + folder browsing + submission + modal rendering

**Warnings (15 found):**
- `Badge.tsx` — combines 7 badge types into one file
- `Tooltip.tsx` — complex positioning logic could be a hook
- `WorkflowComposer.tsx` — API logic mixed with UI state
- `OrchestrationSettingsForm.tsx` — vague `draftKey()` function name, missing comments
- `ProjectDialogs.tsx` — generic `ModalShell` name used for 3 dialog types
- `WorkflowProgressDashboard.tsx` — `taskStateLabel()` and `workflowStatus()` need comments
- `TaskCard.tsx` — large file, selected-mode controls could be extracted
- `TaskOrchestrationPanel.tsx` — `run()` pattern handles busy key + API + notice + error together
- `SendToTerminalButton.tsx` — API calls mixed with UI dropdown rendering
- `TerminalWorkspaceMeta.tsx` — `CleanupResult` interface vague, `modeNote()` lacks comments
- `TerminalSessionToolbar.tsx` — tooltip contents inline without action explanations
- Plus 5 other files with minor issues

**Suggestions (10 found):**
- Minor naming/comment improvements in smaller files
- Extract complex logic into hooks

---

### Agent 4: Correctness Audit
**Status:** Completed — 14 Blockers, 9 Warnings, 12 Suggestions

**Blockers (14 found):**
- CliToolsPage.tsx:163-170 — Disable button disabled state doesn't prevent double-submission
- CliToolsPage.tsx:176-189 — Enable button: same double-submission risk + missing `launchVerified` check
- CliToolsPage.tsx:194-203 — Check button: same double-submission race
- SessionsPage.tsx:200-210 — Stop session button: missing `actionId` check allows double-stop
- SessionsPage.tsx:278-293 — Terminal stop/restart buttons: same global `actionId` race
- TerminalsPage.tsx:212-232 — `runTerminalAction`: global `action` state set AFTER handler starts
- TerminalsPage.tsx:234-253 — `stopSession`: `setSessionStopping(true)` after `window.confirm`
- TerminalsPage.tsx:255-272 — `startAllTerminals`: no guard against re-entry
- TerminalsPage.tsx:277-293 — `deleteSession`: `setDeletingSession(true)` after confirm
- TerminalsPage.tsx:341-386 — `closeTerminal`: complex logic with multiple failure points; inconsistent state on stop failure
- TerminalsPage.tsx:437-440 — Missing workspace mode check doesn't guide user
- TerminalsPage.tsx:524-528 — `resizeSplit`: no validation, no error feedback
- TerminalsPage.tsx:799-806 — Advanced panel toggle: no keyboard accessibility (`aria-expanded`, `aria-controls`)
- TerminalsPage.tsx:664-685 — Task form inputs: no validation, no error feedback

**Warnings (9 found):**
- CliToolsPage.tsx:18-38 — `checkTool`: error handling doesn't distinguish error types
- CliToolsPage.tsx:84-91 — `toggleTool`: same generic error handling
- SessionsPage.tsx:58-67 — Auto-refresh interval: no cleanup on unmount race (actually correct but no visibility-state pause)
- SessionsPage.tsx:100-109 — Refresh button: `void load()` discards promise, no loading feedback
- TerminalsPage.tsx:341-386 — `closeTerminal`: complex logic with multiple failure points
- TerminalsPage.tsx:437-440 — Missing workspace mode check doesn't guide/user focus
- TerminalsPage.tsx:524-528 — `resizeSplit`: silently fails, no visual feedback
- TerminalsPage.tsx:677-685 — Dependencies multi-select: no "none" option, no clear selection
- OverviewPage.tsx:105 & 116 — "New session" buttons: no guard against double-click

**Suggestions (12 found):**
- Consistent loading patterns: `onClick={handler}` where handler sets loading state
- Auto-dismiss toasts after 5-10s
- Replace `window.confirm()` with accessible modal dialogs
- Wrap task form in `<form onSubmit>`, add validation, character count
- Use relative time for "last checked" timestamps
- Persist advanced panel state in workspacePreferences
- Use relative time formatting
- Add "Clear dependencies" button or checkbox list

---

## Merged Priority List (All Blockers First, Then Warnings, Then Suggestions)

### 🔴 BLOCKERS (31 total across all agents)

#### CliToolsPage.tsx Races (3)
1. **CliToolsPage.tsx:163** — Disable button: disabled state only prevents click while `togglingId !== null || checkingId !== null`; rapid clicks can queue multiple async calls before state updates
2. **CliToolsPage.tsx:176** — Enable button: same race condition; `launchVerified` checked in `disabled` but not in handler
3. **CliToolsPage.tsx:194** — Check button: same double-submission race; `checkingId` set after handler starts

#### SessionsPage.tsx Races (2)
4. **SessionsPage.tsx:200** — Stop session button: `disabled={actionId !== null}` checks global state set **inside** the handler; rapid clicks can fire concurrent requests
5. **SessionsPage.tsx:278** — Terminal stop/restart buttons: same global `actionId` race condition

#### TerminalsPage.tsx Races (7)
6. **TerminalsPage.tsx:212** — `runTerminalAction`: `setAction` called after function entry — race window before state updates
7. **TerminalsPage.tsx:234** — `stopSession`: `setSessionStopping(true)` after `window.confirm` — user can click button during confirm
8. **TerminalsPage.tsx:255** — `startAllTerminals`: no guard against re-entry
9. **TerminalsPage.tsx:277** — `deleteSession`: `setDeletingSession(true)` after confirm — race if user clicks twice before confirm completes
10. **TerminalsPage.tsx:341** — `closeTerminal`: inconsistent state on stop failure (proceeds to remove from layout even if stop fails)
11. **TerminalsPage.tsx:437** — Missing workspace mode check: error message tells user what to do but doesn't focus/highlight the mode selector
12. **TerminalsPage.tsx:524** — `resizeSplit`: silently fails if `resizeTerminalSplit` returns null; no toast, no visual feedback
13. **TerminalsPage.tsx:799** — Advanced panel toggle: no `aria-expanded`, `aria-controls`, or keyboard support (Enter/Space)

#### ProjectsPage.tsx Guards (3)
14. **ProjectsPage.tsx:75** — Add project button: no guard against double-open dialog (rapid clicks can open multiple instances)
15. **ProjectsPage.tsx:210** — Rename button: no guard against double-open
16. **ProjectsPage.tsx:216** — Remove project button: no guard against double-open

#### TerminalsPage.tsx Accessibility (1)
17. **TerminalsPage.tsx:806** — Advanced panel toggle: missing `aria-expanded`, `aria-controls`, proper accessible label

---

### 🟡 WARNINGS (24 total across all agents)

#### CliToolsPage.tsx Error Handling (3)
18. **CliToolsPage.tsx:18** — `checkTool`: catch handler shows generic message for all error types (network, 4xx, 5xx)
19. **CliToolsPage.tsx:40** — `toggleTool`: same generic error handling
20. **CliToolsPage.tsx:84** — Overview error notice: `void refresh()` discards promise, no loading feedback during retry

#### SessionsPage.tsx Polling & Refresh (2)
21. **SessionsPage.tsx:58** — Auto-refresh interval: no way to pause when tab hidden (wastes resources)
22. **SessionsPage.tsx:100** — Refresh button: `void load()` discards promise; no loading feedback if load fails

#### TerminalsPage.tsx UX & State Issues (4)
23. **TerminalsPage.tsx:341** — `closeTerminal`: complex logic with multiple failure points; inconsistent state when stop fails
24. **TerminalsPage.tsx:437** — Missing workspace mode check: error message doesn't guide/user focus toward the mode selector
25. **TerminalsPage.tsx:524** — `resizeSplit`: silently fails on null return; no error toast/feedback
26. **TerminalsPage.tsx:677** — Dependencies multi-select: no "none" visual option, Ctrl+Click not obvious how to clear

#### ProjectsPage.tsx UX (1)
27. **ProjectsPage.tsx:42** — `load` function: no abort on rapid searches (uses `requestRef` pattern correctly — actually fine, but warning about debounce display)

#### OverviewPage.tsx Duplicate Buttons (1)
28. **OverviewPage.tsx:105** — Two "New session" buttons (one in sessions section, one in EmptyState) both call `openNewSession` with no disabled state

#### CliToolsPage & SessionsPage UX (2)
29. **CliToolsPage.tsx:159** — "Last checked" timestamp: no relative time, no refresh indicator
30. **OverviewPage.tsx:116** — "New session" button: duplicate without disabled state during navigation

---

### 🟢 SUGGESTIONS (37 total across all agents)

#### Consistent Loading Patterns (multiple)
31. **All pages** — Standardize loading button pattern: `onClick={async handler} { setLoading(true); try { await ... } finally { setLoading(false) } }` rather than split across onClick and disabled state

#### Toast & Notice Patterns (multiple)
32. **All pages** — Auto-dismiss success notices after 5-10s
33. **All pages** — Replace `window.confirm()` with accessible modal dialogs (already have ConfirmationModal, ProjectDialogs)

#### Code Quality & Refactoring (multiple)
34. **TerminalSplitView.tsx, TerminalPanel.tsx, NewSessionDialog.tsx** — Split into 2-3 smaller files per single-responsibility principle (3 blockers already flagged)
35. **All confirm/alert patterns** — Replace `window.confirm()` with accessible modal components

#### Specific Component Suggestions (15)
36. **CliToolsPage.tsx** — Add relative time ("2 min ago") + spinner for "last checked" timestamps
37. **OverviewPage.tsx** — Extract duplicate "New session" button code to shared component
38. **SessionsPage.tsx** — Persist advanced panel state in workspacePreferences
39. **TerminalsPage.tsx** — Add "Clear dependencies" button or checkbox list for multi-select
40. **OverviewPage.tsx** — Show subtle loading indicator in search input when `debouncedSearch !== search`
41. **ProjectsPage.tsx** — Add `maxLength={256}` to search input (already a warning)
42. **All pages** — Connect error states to form fields (show inline validation errors)
43. **SessionsPage.tsx** — Use `document.visibilityState` to pause/resume auto-refresh polling
44. **CliToolsPage.tsx** — Show character counter on task description textarea (4000-char limit)
45. **TerminalsPage.tsx:685** — Wrap task form in `<form onSubmit>`, add Enter-to-submit support

---

## Summary Statistics

| Category | Count | % |
|----------|-------|------|
| **Blockers** | 31 | 48% |
| **Warnings** | 24 | 36% |
| **Suggestions** | 37 | 57% (can overlap with warnings) |

**By File:**
- TerminalsPage.tsx: 11 blockers, 6 warnings, 8 suggestions (most issues — complex terminal orchestration)
- CliToolsPage.tsx: 3 blockers, 3 warnings, 2 suggestions (tool toggle races)
- ProjectsPage.tsx: 3 blockers, 1 warning, 2 suggestions (project management)
- SessionsPage.tsx: 2 blockers, 2 warnings, 1 suggestion (session lifecycle)
- Components: 3 blockers (TerminalSplitView, TerminalPanel, NewSessionDialog — file size/maintainability)
- Other pages/components: distributed findings

**Priority Order for Fixes:**
1. All 31 blockers — fix race conditions, double-submission, missing guards
2. All 24 warnings — improve error handling, UX, client-side validation
3. All 37 suggestions — code quality, maintainability, polish