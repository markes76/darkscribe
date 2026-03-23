# Darkscribe Implementation Plan

## Context

Darkscribe is a simplified macOS Electron app for call transcription and note-taking, forked from the existing Translize app. The key change: replace Translize's complex knowledge system (ChromaDB, NotebookLM, Gemini, speaker diarization, contact management, sentiment analysis) with a clean Obsidian vault integration via obsidian-mcp. The result is a focused tool: record calls, transcribe in real-time, generate summaries, and store everything as markdown in Obsidian.

This is a greenfield build — no existing code in this directory. All source reference comes from the Translize architecture documented in the build prompt.

---

## Project Structure

```
darkscribe/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json / tsconfig.node.json / tsconfig.web.json
├── build/
│   ├── entitlements.mac.plist
│   ├── entitlementsInherit.mac.plist
│   └── icon.icns
├── resources/
│   └── AudioCapture                    # Swift binary (built separately)
├── swift/
│   └── AudioCapture/                   # ScreenCaptureKit source (copied from Translize)
├── src/
│   ├── main/
│   │   ├── index.ts                    # App entry, window creation, IPC setup
│   │   ├── audio-bridge.ts             # Swift subprocess + PCM routing (verbatim)
│   │   ├── recording-writer.ts         # WAV recorder (verbatim)
│   │   ├── session-manager.ts          # Session/call storage (simplified)
│   │   ├── obsidian-mcp-manager.ts     # NEW: obsidian-mcp child process + MCP client
│   │   ├── tavily-search.ts            # Web search (verbatim)
│   │   ├── keychain.ts                 # Encrypted key storage (verbatim)
│   │   └── config.ts                   # App config (simplified schema)
│   ├── preload/
│   │   └── index.ts                    # IPC bridge as window.darkscribe (~30 channels)
│   └── renderer/src/
│       ├── main.tsx                    # React entry
│       ├── App.tsx                     # State machine: loading→onboarding→home→call→summary→settings
│       ├── types/global.d.ts           # DarkscribeAPI type
│       ├── styles/global.css           # Design tokens (CSS custom properties, no Tailwind)
│       ├── services/
│       │   ├── openai-realtime.ts      # Dual-channel WebSocket transcription (simplified)
│       │   └── summarizer.ts           # Post-call summary with skill file awareness
│       ├── hooks/
│       │   └── useRealtimeTranscription.ts  # Audio + WebSocket coordination (no diarization)
│       └── components/
│           ├── TopNav.tsx
│           ├── SessionList.tsx         # Home screen (simplified, no relationships)
│           ├── MainApp.tsx             # Active call UI (2-panel: transcript + search)
│           ├── PostCallSummary.tsx      # Summary review + save to vault
│           ├── Settings.tsx            # Simplified settings
│           ├── SessionView/
│           │   ├── AudioControls.tsx
│           │   └── Transcript.tsx
│           ├── SearchPanel/
│           │   └── VaultSearchPanel.tsx # NEW: vault search + Tavily fallback
│           └── Onboarding/
│               ├── OnboardingFlow.tsx
│               ├── WelcomeStep.tsx
│               ├── VaultSelectorStep.tsx    # NEW
│               ├── ApiKeyStep.tsx
│               ├── AudioPermissionStep.tsx
│               ├── VaultSetupStep.tsx       # NEW
│               └── DoneStep.tsx
```

---

## Key Architectural Decisions

1. **obsidian-mcp via `@modelcontextprotocol/sdk` Client** — Translize's `mcp-server-manager.ts` uses raw JSON-RPC with manual request ID tracking. We'll use the SDK Client which handles framing, correlation, and capability negotiation. Spawns `npx -y obsidian-mcp <vaultPath>` as child process with StdioClientTransport.

2. **Dual storage model** — Electron userData holds operational state (sessions.json, WAV recordings, config, keychain). Obsidian vault holds knowledge output (transcripts, summaries, references, skill file). `vaultNotePath` in CallRecord bridges them.

3. **Speaker attribution without diarization** — Remove sherpa-onnx entirely. Use channel labels: mic = "You", system audio = "Them". GPT-4o can attribute speakers during summarization.

4. **CSS custom properties only** — Translize's components already use `var(--*)` inline styles. Removing Tailwind is just removing the Vite plugin and devDep. No component CSS changes needed.

5. **State machine simplification** — From 9 states to 6: `loading | onboarding | home | call | summary | settings`. Remove: `unsupported-os`, `setup`, `relationships`.

6. **IPC reduction** — From ~55 channels to ~30. Remove all `knowledge:*`, `speaker:*`, `contact:*`, `skill:*`, `audioBuffer:*`, `gemini:*`, `notebooklm:*`, `platformSkill:*`, `followup:*` channels. Add `vault:*` namespace (~10 channels).

---

## Phase 1: Strip and Simplify

**Goal**: Clean project that compiles and launches with working audio capture + transcription.

### Files to create/adapt

| File | Action | Notes |
|------|--------|-------|
| `package.json` | Create | Name: darkscribe. Keep: openai, @tavily/core, react, react-dom, ws, zod, zustand. Remove: chromadb, mammoth, papaparse, pdf-parse, sherpa-onnx-node, tailwindcss, @tailwindcss/vite |
| `electron.vite.config.ts` | Create | Same as Translize minus tailwindcss() plugin |
| `electron-builder.yml` | Create | Rename to Darkscribe, appId: com.darkscribe.app, remove python extraResources |
| `tsconfig*.json` | Copy | Verbatim from Translize |
| `build/entitlements*` | Copy | Verbatim (mic + screen capture entitlements) |
| `swift/AudioCapture/` | Copy | Entire directory verbatim |
| `src/main/audio-bridge.ts` | Copy | Verbatim |
| `src/main/recording-writer.ts` | Copy | Verbatim |
| `src/main/keychain.ts` | Copy | Verbatim |
| `src/main/tavily-search.ts` | Copy | Verbatim |
| `src/main/config.ts` | Adapt | New schema: `{ onboarding_complete, theme, vault_path, recordings_enabled, recordings_retention_days }` |
| `src/main/session-manager.ts` | Simplify | Remove contact association, sentiment, doc paths, skill IPC. Add `vaultNotePath` to CallRecord |
| `src/main/index.ts` | Simplify | Remove imports for knowledge-base, vector-store, gemini, speaker-diarizer, platform-skill, contact-store, mcp-server-manager (old). Keep: audio-bridge, recording-writer, session-manager, tavily, keychain, config |
| `src/preload/index.ts` | Simplify | Remove ~25 channel namespaces. Rename window.translize → window.darkscribe |
| `src/renderer/src/App.tsx` | Simplify | States: loading→onboarding→home→call→summary→settings |
| `src/renderer/src/types/global.d.ts` | Adapt | Rename TranslizeAPI → DarkscribeAPI |
| `src/renderer/src/styles/global.css` | Copy | Remove any @tailwind directives. Keep all CSS custom properties |
| `src/renderer/src/services/openai-realtime.ts` | Simplify | Remove audio-buffer/embedding callbacks |
| `src/renderer/src/services/summarizer.ts` | Simplify | Remove diarization, sentiment. Keep: overview, key topics, action items, decisions, follow-ups |
| `src/renderer/src/hooks/useRealtimeTranscription.ts` | Simplify | Remove sherpa-onnx speaker detection. Channel-based: mic="You", sys="Them" |
| `src/renderer/src/components/MainApp.tsx` | Simplify | Remove ContextPanel, CallIntelligence, sentiment. 2-panel: transcript + controls |
| `src/renderer/src/components/PostCallSummary.tsx` | Simplify | Remove sentiment, skill manager, NLM sync. Keep summary display + save |
| `src/renderer/src/components/SessionList.tsx` | Simplify | Remove relationship dashboard links, contact filtering |
| `src/renderer/src/components/Settings.tsx` | Simplify | Remove Gemini, NotebookLM, contact sections. Keep: API keys, theme, vault path |
| `src/renderer/src/components/Onboarding/` | Stub | Minimal flow for Phase 1 (full redesign in Phase 3) |

### Files NOT ported (removed)
- knowledge-base.ts, vector-store.ts, speaker-diarizer.ts, contact-store.ts
- platform-skill.ts, gemini-service.ts, mcp-server-manager.ts (old)
- sentiment-engine.ts, skill-manager.ts
- RelationshipsDashboard.tsx, KnowledgePanel/ContextPanel.tsx
- python/ directory entirely

### Verification
- `npm run dev` launches the app
- Onboarding collects OpenAI API key
- Starting a call captures audio (mic + system)
- Transcript appears in real-time with "You"/"Them" labels
- Ending a call generates a summary
- Session is saved to userData/sessions.json

---

## Phase 2: Obsidian Integration

**Goal**: App reads/writes to Obsidian vault via obsidian-mcp child process.

### New files

| File | Description |
|------|-------------|
| `src/main/obsidian-mcp-manager.ts` | Spawn obsidian-mcp, MCP client lifecycle, IPC handlers |
| `src/renderer/src/components/SearchPanel/VaultSearchPanel.tsx` | Vault search + Tavily fallback UI |

### obsidian-mcp-manager.ts design

```
Spawn: npx -y obsidian-mcp <vaultPath>
Transport: StdioClientTransport (stdin/stdout pipes)
Client: @modelcontextprotocol/sdk Client
Reconnection: MAX_RESTARTS=3, exponential backoff (2000ms * attempt)

Exposed IPC channels:
  vault:connect(vaultPath) → { ok }
  vault:disconnect() → { ok }
  vault:status() → { connected, vaultPath }
  vault:read-note(path) → { content } | { error }
  vault:create-note(path, content) → { ok }
  vault:edit-note(path, content) → { ok }
  vault:search(query) → { results: [{ path, snippet }] }
  vault:create-directory(path) → { ok }
  vault:add-tags(path, tags) → { ok }
  vault:manage-tags() → { tags }
```

### Data flow for completed call

1. During call: transcript segments accumulate in renderer, WAV in main process
2. Call ends → navigate to summary state
3. Summarizer generates summary (skill file awareness added in Phase 4)
4. Session saved to sessions.json with call metadata
5. WAV saved to userData/sessions/<id>/
6. "Save to Vault" creates markdown at `Calls/YYYY-MM-DD_HH-mm_<name>.md` with YAML frontmatter (date, duration, tags, recording_path) + transcript + summary
7. `vaultNotePath` stored in sessions.json call record

### Modifications

- `package.json`: Add `@modelcontextprotocol/sdk`
- `src/main/index.ts`: Import + setup obsidian-mcp-manager
- `src/preload/index.ts`: Add `vault` namespace
- `src/main/session-manager.ts`: Add vault note creation after call save
- `src/renderer/src/components/MainApp.tsx`: Replace right panel with VaultSearchPanel
- `src/renderer/src/components/PostCallSummary.tsx`: Add "Save to Vault" button

### Verification
- obsidian-mcp spawns on app launch (after vault path configured)
- `vault:search` returns results from existing vault notes
- Completing a call and clicking "Save to Vault" creates a markdown file in the vault
- File appears in Obsidian with correct frontmatter and content

---

## Phase 3: Onboarding and Vault Setup

**Goal**: First-run experience that configures vault and bootstraps directory structure.

### Onboarding flow (6 steps)

1. **WelcomeStep** — Darkscribe branding + tagline
2. **VaultSelectorStep** — File picker for vault root. Validates `.obsidian/` exists OR offers to init. Saves `vault_path` to config
3. **ApiKeyStep** — OpenAI (required), Tavily (optional). Stored via keychain
4. **AudioPermissionStep** — Mic + Screen Recording permission requests
5. **VaultSetupStep** — Auto-creates directory structure + template files via obsidian-mcp. Shows progress
6. **DoneStep** — "Darkscribe is ready" confirmation

### Auto-created vault structure

```
{{VAULT}}/
├── Calls/Transcripts/
├── Calls/Summaries/
├── Notes/Meetings/
├── Notes/Ideas/
├── Notes/Research/
├── Daily/
├── Templates/
│   ├── Call Summary.md
│   ├── Meeting Note.md
│   └── Daily Note.md
├── Resources/References/
└── System/
    └── Notetaker Skill.md
```

### Verification
- Fresh install → onboarding appears
- Vault selector validates directory
- API keys stored and retrievable
- Audio permissions granted
- All vault directories + template files created
- Notetaker Skill.md exists with initial content
- App transitions to home screen

---

## Phase 4: Self-Teaching Skill File

**Goal**: Summarizer learns from user edits over time.

### Skill file location
`{{VAULT}}/System/Notetaker Skill.md`

### Integration flow

1. **Before summarization**: Main process reads skill file via `vault:read-note`. Content passed to renderer
2. **During summarization**: Skill file content injected into GPT-4o system prompt as formatting/vocabulary preferences
3. **After save**: `originalSummary` markdown stored in sessions.json call record
4. **Learning detection**: On next app launch or after delay, compare vault note (potentially user-edited) against `originalSummary`. If different, call GPT-4o to extract learnings as structured diffs
5. **Skill file update**: Append learnings to appropriate section via `vault:edit-note`
6. **Consolidation**: Every 5 calls, GPT-4o consolidates the skill file (dedup, prioritize recent patterns)

### Modifications

- `src/renderer/src/services/summarizer.ts`: Accept `skillContent?: string` parameter, include in system prompt
- `src/renderer/src/components/PostCallSummary.tsx`: Store originalSummary in call record
- `src/main/session-manager.ts`: Add originalSummary field to CallRecord
- New background task in main process for diff detection + learning extraction

### Verification
- Summary generation includes skill file preferences
- Editing a saved vault note → learnings appear in Notetaker Skill.md
- After 5 calls, skill file is consolidated
- Manual edits to skill file in Obsidian are respected on next read

---

## Phase 5: Tavily Integration

**Goal**: Manual web search with vault-first fallback.

### Search flow in VaultSearchPanel

1. User types query
2. `vault:search` runs first → display results
3. If insufficient, user clicks "Search Web" → `tavily:search`
4. Web results display with title, snippet, URL
5. "Save to Vault" on any result → creates `Resources/References/YYYY-MM-DD_<query>.md` with YAML frontmatter (date, source_url, query, tags: [reference, web-search]) + content

### Verification
- Vault search returns relevant results
- "Search Web" calls Tavily and displays results
- "Save to Vault" creates properly formatted reference note in vault

---

## Dependencies (final)

### Runtime
- `openai` — Realtime API transcription + GPT-4o summarization
- `@tavily/core` — Web search
- `@modelcontextprotocol/sdk` — obsidian-mcp client
- `react`, `react-dom` — UI
- `ws` — WebSocket for OpenAI Realtime
- `zod` — Schema validation
- `zustand` — State management

### Dev
- `electron` (34.x), `electron-builder`, `electron-vite`
- `@vitejs/plugin-react`, `vite`
- `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `@types/ws`
- `@electron/rebuild`, `concurrently`
