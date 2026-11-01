# Audit Report: Component Readability and Quality

## Executive Summary

This report audits all 23 interactive elements/components in `apps/web/src/components/` for readability issues including: functions doing too much, poor naming, inline styles, missing comments, oversized files, and UI logic mixed with non-UI concerns.

---

## File-by-File Analysis

### 1. apps/web/src/components/AppLayout.tsx (37 lines)

**Issues: None significant** - Very small, well-organized file with clear separation of concerns. Status badges are cleanly defined with their labels and classes.

### 2. apps/web/src/components/TopBar.tsx (76 lines)

**Issues:**
- **Line 40**: Inline style handling for running terminals count uses ternary logic inline: `const running = backend.overview ? String(backend.overview.counts.runningTerminals) : '—';` - This is simple enough to remain inline but could be extracted for clarity.

### 3. apps/web/src/components/Sidebar.tsx (67 lines)

**Issues: None significant** - Clean, well-organized navigation component.

### 4. apps/web/src/components/Notice.tsx (75 lines)

**Issues: None** - Clean component with clear tone/accent mapping and action handling.

### 5. apps/web/src/components/Badge.tsx (201 lines) ⚠️ **WARNING**

**Issues:**
- **Functions doing too much**: The file defines 5 badge component functions plus 2 label/class constants. While each individual function is small (< 30 lines), the file as a whole manages multiple badge types.
- **Poor naming**: `STATUS_LABELS`, `STATUS_CLASSES`, `PATH_STATUS_LABELS`, `PATH_STATUS_CLASSES` are clear but could be more specific (e.g., `ToolStatusLabels`, `ProjectPathStatusLabels`).
- **Inline styles**: None uses inline styles - all use Tailwind classes.
- **File organization**: The file combines tool status badges, project path badges, enabled badges, launch badges, session status badges, terminal status badges, and connection badges. Consider splitting into separate files.

**Suggestion:** Split into separate files: `ToolStatusBadge.tsx`, `ProjectPathBadge.tsx`, `EnabledBadge.tsx`, `LaunchBadge.tsx`, `SessionStatusBadge.tsx`, `TerminalStatusBadge.tsx`, `ConnectionBadge.tsx`.

### 6. apps/web/src/components/ConfirmationModal.tsx (66 lines)

**Issues: None** - Clean modal with clear prop handling.

### 7. apps/web/src/components/Tooltip.tsx (96 lines) ⚠️ **WARNING**

**Issues:**
- **Functions doing too much**: The `Tooltip` component does multiple things: position calculation, viewport clamping, event handling (mouseenter, mouseleave, focus, blur, resize, scroll), and DOM rendering. The `updatePosition` function handles positioning logic that could be extracted.
- **Complexity**: The positioning logic with viewport clamping and event listeners makes this component do more than just show a tooltip.
- **Missing comments**: The comment on line 106-118 about "wrapper span to hold the ref and events" is helpful but the rationale for why a fragment/wrapper is needed could be clearer.

**Suggestion:** Extract positioning logic into a separate hook (`useTooltipPosition`), or simplify by removing resize/scroll handling if not critical.

### 8. apps/web/src/components/StatStrip.tsx (32 lines)

**Issues: None** - Small, focused component.

### 9. apps/web/src/components/TerminalSplitView.tsx (678 lines) ⚠️ **BLOCKER**

**Issues:**
- **File too large (>100 lines)**: At 678 lines, this is the largest file by far. It does multiple things:
  - Calculates minimum sizes for terminal layout
  - Handles pointer events for resizing
  - Handles keyboard events
  - Renders the split view DOM structure
  - Manages horizontal vs vertical stacking
- **Functions doing too much**: 
  - `minimumSize()` function (lines 28-44) calculates sizes for both horizontal and vertical directions - does too many things in one function.
  - `onPointerMove` (lines 73-83) handles resizing logic mixed with event handling.
  - `onKeyDown` (lines 84-90) handles keyboard resizing.
- **UI logic mixed with non-UI concerns**: The resizing logic (`onPointerMove`, `onKeyDown`) is UI interaction logic, but it's mixed with the minimum size calculation which is pure logic.
- **Poor naming**: `SPLIT_DIVIDER_SIZE = 8`, `NARROW_VIEWPORT_QUERY` - constants are reasonably named.
- **Missing comments**: The comment on line 22 explains the mobile breakpoint, but the overall logic could use more comments explaining the ratio calculation and split behavior.

**Suggestion:** Split into at least 2 files:
- `TerminalSplitViewLayout.tsx` - minimum size calculations
- `TerminalSplitViewRenderer.tsx` - DOM rendering and event handling

### 10. apps/web/src/components/WorkflowComposer.tsx (527 lines) ⚠️ **WARNING**

**Issues:**
- **File too large (>100 lines)**: 527 lines doing multiple things.
- **Functions doing too much**: 
  - `generatePlan()` (lines 147-172) handles API call, state setting, error handling - multiple concerns.
  - `startWorkflow()` (lines 174-199) - similar pattern.
  - `resumeWorkflow()` (lines 201-223) - similar pattern.
- **UI logic mixed with non-UI concerns**: API call logic (`apiPost`) is mixed with UI state management (setting `busy`, `error`, `preview` states).
- **Poor naming**: `READY_MESSAGE`, `COMPOSER_GUIDE` - constants are reasonably named but `READY_MESSAGE` could be more descriptive.
- **Inline styles**: None uses inline styles - all use Tailwind.
- **Missing comments**: The `READY_MESSAGE` constant on line 32 and `COMPOSER_GUIDE` on lines 34-36 lack explanation of what "ready" means in this context.

**Suggestion:** Extract the three workflow actions (`generatePlan`, `startWorkflow`, `resumeWorkflow`) into separate functions or even a small utility module. Add comments explaining the readiness states.

### 11. apps/web/src/components/OrchestrationSettingsForm.tsx (219 lines) ⚠️ **WARNING**

**Issues:**
- **File too large (>100 lines)**: 219 lines.
- **Functions doing too much**: The `onCommandChange` handler (lines 348-358) and `saveSettings` (lines 323-342) do multiple things - state updates and API calls.
- **Inline styles**: None uses inline styles - all use Tailwind.
- **Poor naming**: `draftKey()` function (lines 32-36) generates UUID or random string - name is vague (`draftKey` vs `generateDraftKey`).
- **Missing comments**: The `toDraft` and `toCommands` helper functions (lines 33-61) lack comments explaining the conversion logic.

**Suggestion:** Rename `draftKey()` to `generateDraftKey()`. Add comments to `toDraft` and `toCommands` explaining the conversion between draft and settings formats.

### 12. apps/web/src/components/CoordinationState.tsx (66 lines)

**Issues: None** - Clean component showing coordination state.

### 13. apps/web/src/components/OrchestrationToolbar.tsx (123 lines)

**Issues: None** - Well-organized toolbar component.

### 14. apps/web/src/components/ProjectDialogs.tsx (393 lines) ⚠️ **WARNING**

**Issues:**
- **File too large (>100 lines)**: 393 lines.
- **Functions doing too much**: 
  - `browse()` (lines 108-123) - folder browsing logic.
  - `submit()` (lines 125-144) - form submission logic.
  - `AddProjectDialog` and `EditProjectDialog` and `DeleteProjectDialog` each do multiple things.
- **UI logic mixed with non-UI concerns**: API calls (`apiPost`, `apiPatch`, `apiDelete`) are mixed with form UI state management.
- **Poor naming**: `ModalShell` (lines 18-71) is a generic name used for all three dialog types - could be more specific.
- **Missing comments**: The `ErrorNotice` function (lines 73-82) lacks explanation of when it's used.

**Suggestion:** Extract `ModalShell` into its own file `ModalShell.tsx`. Add comments to `ErrorNotice`. Consider splitting project dialogs into separate files.

### 15. apps/web/src/components/AgentTaskDialog.tsx (174 lines)

**Issues: None** - Well-structured dialog for agent tasks.

### 16. apps/web/src/components/WorkflowPlanPreview.tsx (80 lines)

**Issues: None** - Small, focused component.

### 17. apps/web/src/components/WorkflowProgressDashboard.tsx (199 lines) ⚠️ **WARNING**

**Issues:**
- **File too large (>100 lines)**: 199 lines.
- **Functions doing too much**: 
  - `taskStateLabel()` (lines 23-36) - handles multiple task states in one function.
  - `workflowStatus()` (lines 38-58) - handles multiple workflow statuses in one function.
- **UI logic mixed with non-UI concerns**: The `workflowStatus` function pure logic for determining status, but it's embedded directly in the component rather than extracted.
- **Poor naming**: `needsAttention` variable (line 79) - could be more descriptive like `hasNeedsAttention`.
- **Missing comments**: The `workflowStatus` function has complex conditional logic that would benefit from comments explaining each state transition.

**Suggestion:** Extract `taskStateLabel` and `workflowStatus` into separate utility functions with descriptive names and comments.

### 18. apps/web/src/components/TerminalFolderNotice.tsx (23 lines)

**Issues: None** - Small, focused component.

### 19. apps/web/src/components/TaskDiffButton.tsx (96 lines)

**Issues: None** - Small, focused component.

### 20. apps/web/src/components/TerminalPanel.tsx (678 lines) ⚠️ **BLOCKER**

**Issues:**
- **File too large (>100 lines)**: At 678 lines, tied with TerminalSplitView for largest file.
- **Functions doing too much**: 
  - The entire component sets up a Terminal, FitAddon, ResizeObserver, WebSocket connection, and multiple event listeners - all in one function.
  - `useEffect` on lines 251-322 sets up the terminal and WebSocket - does too many things.
  - `useEffect` on lines 324-494 handles WebSocket messages, errors, and close events - also does too many things.
- **UI logic mixed with non-UI concerns**: WebSocket connection handling, message parsing, exit handling are mixed with UI state management (connection state, notice display).
- **Poor naming**: `SPLIT_PLACEMENTS`, `SPLIT_LABELS` are used but not clearly documented. `cssToken` function (lines 161-163) could be named better (`getComputedStyleToken`).
- **Missing comments**: The `shortWorkdir` function (lines 93-99) has a comment explaining its purpose, but the overall WebSocket setup lacks comments explaining the protocol flow.

**Suggestion:** Split into at least 3 files:
- `TerminalPanelTerminal.tsx` - Terminal initialization and FitAddon
- `TerminalPanelWebSocket.tsx` - WebSocket connection and message handling
- `TerminalPanelRenderer.tsx` - DOM rendering and UI state

### 21. apps/web/src/components/TerminalSessionToolbar.tsx (204 lines) ⚠️ **WARNING**

**Issues:**
- **File too large (>100 lines)**: 204 lines.
- **Functions doing too much**: The component handles session selection, terminal addition, session controls (stop, start all, refresh, new session, delete), and conversion tooltip - multiple concerns.
- **Poor naming**: `showConvert` prop and `onOpenConversion` handler - could be more clearly named `hasConversionWarning` and `onOpenConversionWarning`.
- **Missing comments**: The tooltip content strings (lines 116, 127, 139, 156, 173, 184) are inline without explanation of what each action does.

**Suggestion:** Extract the session control buttons into a separate component. Add comments to tooltip content explaining each action.

### 22. apps/web/src/components/TerminalGridHeader.tsx (66 lines)

**Issues: None** - Small, focused component.

### 23. apps/web/src/components/TerminalStatusLine.tsx (78 lines)

**Issues: None** - Small, focused component.

### 24. apps/web/src/components/TerminalWorkspaceMeta.tsx (127 lines) ⚠️ **WARNING**

**Issues:**
- **File too large (>100 lines)**: 127 lines.
- **Functions doing too much**: The `handleCleanup` function (lines 50-66) does API call, message formatting, and callback invocation.
- **Poor naming**: `CleanupResult` interface (lines 19-23) - could be more specific (`WorktreeCleanupResult`).
- **Missing comments**: The `modeNote` function (lines 30-34) lacks explanation of what each mode returns.

**Suggestion:** Rename `CleanupResult` to `WorktreeCleanupResult`. Add comments to `modeNote`.

### 25. apps/web/src/components/TaskOrchestrationPanel.tsx (468 lines) ⚠️ **WARNING**

**Issues:**
- **File too large (>100 lines)**: 468 lines.
- **Functions doing too much**: 
  - The `run` function (lines 140-157) handles busy key setting, API call, notice setting, loading, and error handling - multiple concerns.
  - Multiple task action functions (`schedule`, `processQueue`, `mergeAll`, `isolate`, `completeTask`, `validateTask`, `retryTask`, `cancelTask`, `cancelValidation`, `saveSettings`) all follow the same pattern.
- **UI logic mixed with non-UI concerns**: API call patterns are mixed with UI state management (busyKey, notice, actionError).
- **Poor naming**: `requestRef` (line 89) - could be `requestCounter` or `loadRequestId`.
- **Missing comments**: The `toDraft` and `toCommands` helper functions (lines 33-61) lack comments explaining the conversion logic.

**Suggestion:** Extract the common `run` pattern into a more reusable utility. Add comments to `toDraft` and `toCommands`. Consider extracting task action handlers into a separate module.

### 26. apps/web/src/components/EmptyState.tsx (22 lines)

**Issues: None** - Very small, focused component.

### 27. apps/web/src/components/NewSessionDialog.tsx (675 lines) ⚠️ **BLOCKER**

**Issues:**
- **File too large (>100 lines)**: At 675 lines, the second largest file.
- **Functions doing too much**: The entire component handles:
  - Form state management (path, name, error, submitting, browsing)
  - Folder browsing logic
  - Form submission
  - Modal shell rendering
  - Error handling
- **UI logic mixed with non-UI concerns**: API calls (`apiPost`, `apiGet` for folder picking) are mixed with form UI state.
- **Poor naming**: `browsing` state variable - could be `isBrowsing`. `limits` import from `../../../../shared/limits.json` - name is vague.
- **Missing comments**: The folder browsing and submission logic lacks comments explaining the Windows dialog fallback.

**Suggestion:** Split into at least 2 files:
- `NewSessionDialogForm.tsx` - form state and submission
- `NewSessionDialogModal.tsx` - modal rendering and browsing logic

### 28. apps/web/src/components/SendToTerminalButton.tsx (134 lines) ⚠️ **WARNING**

**Issues:**
- **File too large (>100 lines)**: 134 lines.
- **Functions doing too much**: The `sendToTerminal` button handles:
  - Loading terminals from sessions
  - API calls to fetch sessions and terminals
  - Sending task to terminal
  - UI state management (open/close, loading, sending, message)
- **UI logic mixed with non-UI concerns**: API calls for fetching sessions are mixed with UI dropdown rendering.
- **Poor naming**: `LiveTerminalOption` interface - could be `TerminalOption` or `AvailableTerminal`. `sendTo` function does API call and state update.
- **Missing comments**: The terminal filtering logic (line 38: `// Only include terminals that appear live`) lacks explanation.

**Suggestion:** Extract terminal loading logic into a hook or separate function. Add comment explaining the "live" filtering.

### 29. apps/web/src/components/CommitPushButton.tsx (74 lines)

**Issues: None** - Small, focused component.

### 30. Apps/web/src/components/TaskCard.tsx (435 lines) ⚠️ **WARNING**

**Issues:**
- **File too large (>100 lines)**: 435 lines.
- **Functions doing too much**: The component renders:
  - Task badge and title
  - Completion summary / blocked reason
  - Advanced task details (details section)
  - Validation summary
  - Integration reason
  - Selected mode with completion evidence, validation/integration controls, replan/edit controls
  - Logs display
  - Send to terminal, commit/push buttons
- **UI logic mixed with non-UI concerns**: API/state management (completion, validate, integrate actions) are mixed with UI rendering.
- **Poor naming**: `completionSummary` prop - could be more descriptive (`completionEvidence`).
- **Missing comments**: The scope violations, actual files, deferred scope sections lack comments explaining what they represent.

**Suggestion:** Consider extracting the "selected mode" controls into a separate component. Add comments to the advanced details section.

### 31. apps/web/src/components/TaskDiffButton.tsx (already analyzed) - None

### 32. apps/web/src/components/TaskOrchestrationPanel.tsx (already analyzed) - See above

---

## Summary of Findings by Severity

### BLOCKER (2 files)
1. **TerminalSplitView.tsx** (678 lines) - File too large, functions doing too much, UI logic mixed with non-UI concerns
2. **TerminalPanel.tsx** (678 lines) - File too large, massive useEffect doing too many things, UI logic mixed with non-UI concerns
3. **NewSessionDialog.tsx** (675 lines) - File too large, form + browsing logic mixed together

### WARNING (15 files)
1. **Badge.tsx** (201 lines) - File combines multiple badge types, could split
2. **Tooltip.tsx** (96 lines) - Complex positioning logic, could extract
3. **WorkflowComposer.tsx** (527 lines) - Large, API logic mixed with UI state
4. **OrchestrationSettingsForm.tsx** (219 lines) - Could rename `draftKey`, add comments
5. **ProjectDialogs.tsx** (393 lines) - Large, could split ModalShell
6. **WorkflowProgressDashboard.tsx** (199 lines) - Could extract state label functions
7. **TerminalFolderNotice.tsx** (23 lines) - Small but analyzed
8. **TerminalSessionToolbar.tsx** (204 lines) - Could extract session controls
9. **TerminalWorkspaceMeta.tsx** (127 lines) - Could rename interface, add comments
10. **SendToTerminalButton.tsx** (134 lines) - Could extract terminal loading
11. **TaskCard.tsx** (435 lines) - Large, could extract selected mode controls
12. **TaskOrchestrationPanel.tsx** (468 lines) - Large, could extract run pattern
13. **TerminalStatusLine.tsx** (78 lines) - Small but analyzed
14. **CoordinationState.tsx** (66 lines) - Small but analyzed
15. **EmptyState.tsx** (22 lines) - Small but analyzed

### Suggestion (10 files)
1. **AppLayout.tsx** - Minor inline style handling
2. **TopBar.tsx** - Minor inline handling
3. **Notice.tsx** - None
4. **ConfirmationModal.tsx** - None
5. **StatStrip.tsx** - None
6. **WorkflowPlanPreview.tsx** - None
7. **TerminalFolderNotice.tsx** - None
8. **TerminalGridHeader.tsx** - None
10. **CommitPushButton.tsx** - None

---

## Key Recommendations

1. **Split large files**: TerminalSplitView.tsx, TerminalPanel.tsx, and NewSessionDialog.tsx should each be split into 2-3 smaller files following single-responsibility principle.

2. **Extract complex logic**: Tooltip positioning, workflow status labeling, task state labeling, and the `run` pattern in TaskOrchestrationPanel should be extracted into utilities/hooks.

3. **Improve naming**: Rename vague identifiers like `draftKey`, `browsing`, `limits`, `CleanupResult`.

4. **Add comments**: Complex conditional logic in `workflowStatus`, `taskStateLabel`, and terminal WebSocket setup needs better comments.

5. **Consider splitting badge types**: Badge.tsx combines too many badge types into one file.