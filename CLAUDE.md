# FeynMind

FeynMind is an open-source (MIT), local-first desktop app that turns a course's textbooks, slide decks and syllabus into an adaptive tutor. Users bring their own AI provider keys and assign a model to each role.

Read these before any non-trivial work:

- `docs/PRD.md`: what the product does and why. It is the source of truth for behavior.
- `docs/tech-plan.md`: the stack, module layout, milestones and risks.

If a request conflicts with either document, say so and ask before proceeding. If a decision changes, update the document in the same change.

## Current milestone

**Milestone 6a: Retention** (see `docs/tech-plan.md`, Build plan). Milestones 1 (Skeleton), 2 (Ingestion), 3 (Knowledge), 4 (Tutor loop) and 5 (Dictation, the first public release) are done. Milestone 6b (providers, roles and fallback) comes after 6a; do not start it yet.

Work on one milestone at a time. Do not build features from later milestones, even when it seems convenient. A milestone is finished only when its "Done when" test passes. Update this section when a milestone is completed.

## Stack

- Electron with electron-vite, TypeScript in strict mode everywhere
- React with Vite for the interface
- SQLite through better-sqlite3, with sqlite-vec for vector search
- Vercel AI SDK for all model calls
- Vitest for unit tests, Playwright for full-app tests
- Other libraries are listed in `docs/tech-plan.md`. Use the listed choice. Ask before adding a dependency that is not listed.

## Architecture rules

- `src/main/` is the background process. All file access, database access, key handling and model calls happen here.
- `src/renderer/` is the interface. It only displays state and collects input. It never touches the file system, the database, API keys or provider SDKs.
- The two halves talk only through typed channels defined in `src/main/ipc.ts`, exposed through `src/preload/index.ts`. Shared types live in `src/shared/`.
- Keep the renderer sandboxed: context isolation on, Node integration off.
- Each folder under `src/main/` is one module (providers, ingestion, knowledge, learner, tutor, dictation, pathways, storage). A module exposes a small public interface from its `index.ts`; other modules import only from that.
- All model calls go through `src/main/providers/`. No other module imports a provider SDK. The tutor asks for a role ("teaching", "grading"), never for a named model.
- Tutor prompts are plain text files in `prompts/`, loaded at runtime. Do not write prompt text inline in code.
- Database changes go through numbered migrations in `src/main/storage/`. Never edit a migration that has shipped.
- Long jobs (ingestion, concept extraction) must be resumable and must cache model results, so no page is ever paid for twice.

## Keys, privacy and cost

- Never commit, print or log an API key. Never include one in a test fixture, a snapshot or an error message.
- Development keys live in `.env.local`, which is git-ignored. In the app, user keys are stored with Electron safeStorage.
- Unit tests use fake providers and make no network calls. Tests that use real keys are opt-in behind an environment flag and use the cheapest available model.
- No telemetry and no network calls other than to the user's chosen providers and one-time model downloads.
- Before running anything that could make many model calls, state the estimated number of calls and wait for approval.

## Licensing and content

- The project is MIT. Before adding a dependency, check that its license is compatible (MIT, Apache 2.0, BSD and ISC are fine). Flag anything else.
- Never copy code from AGPL or GPL projects, including LearnHarness. Ideas are fine; code is not.
- Never commit copyrighted textbooks or slides. Test fixtures in `tests/fixtures/` must be openly licensed (for example, OpenStax chapters) or written for this project. Record each fixture's source and license in `tests/fixtures/README.md`.

## Working style

- Before writing code for a task, give a short plan: the files you will touch and how you will verify the result.
- Keep changes small and focused. One concern per commit, with a clear message.
- Do not add `Co-Authored-By` trailers, "Generated with Claude Code" text or any other AI attribution to commits or pull requests. Attribution is turned off in `.claude/settings.json`; keep it off.
- Write tests alongside the code. A feature is not done until its tests pass and `npm run typecheck` and `npm run lint` are clean.
- Prefer simple, readable code over clever code. Do not add abstractions for needs that do not exist yet.
- Do not leave placeholder implementations or silent fallbacks. If something cannot be finished, say so plainly and leave a clear `TODO` with the reason.
- When behavior depends on a provider's API, check the provider's current documentation instead of relying on memory.
- If a requirement is ambiguous, ask one specific question before building.

## Commands

Keep this section current.

```
npm install          # install dependencies; postinstall rebuilds better-sqlite3 for Electron
npm run dev          # run the app in development (reads GEMINI_API_KEY from .env.local if no key is saved)
npm test             # unit tests, run inside Electron's Node; no network (about a minute: includes local OCR)
npm run test:e2e     # builds, then Playwright opens the app with a throwaway profile; no network (model download off, model replies replayed); the dictation test uses a fake microphone and needs the Whisper tiny model (run test:models once)
npm run test:live    # opt-in: 2 real Gemini calls (list models + one short prompt) using .env.local
FEYNMIND_LIVE_BATCH=A node scripts/run-vitest.mjs --live run --config vitest.live.config.mts tests/live/knowledge.live.test.ts  # opt-in: one batch of real knowledge calls (A/B/E 2, C 4, D 2, models 1; toc and dump 0) on fixtures only; writes tests/fixtures/recorded/
FEYNMIND_LIVE_BATCH=G node scripts/run-vitest.mjs --live run --config vitest.live.config.mts tests/live/tutor.live.test.ts  # opt-in: real tutor calls on fixtures only (G 5, bench-minimal 22, bench-low 22, contest 2, reasoning 10; allowed 0); each batch stops at a fixed ceiling (G 15, bench 24, contest 3, reasoning 11); writes tests/fixtures/recorded/
npm run test:models  # opt-in: downloads the pinned embedding model (~35 MB) and the three Whisper models (~375 MB; FEYNMIND_SPEECH_MODELS=base.en limits it) once, checks vectors and speech-recognition word error rate and prints timings; no model API calls
npm run bench:ingest -- <file> [...] [--queries q.json]  # real pipeline on your own files, throwaway database, prints timings; checks expected pages in q.json
npm run bench:ingest -- "<Strang PDF>" --queries tests/bench/strang-regression.json  # search regression set (13 checks, ~8 min); run after any search change
npm run bench:ingest -- "<Strang PDF>" --queries tests/bench/strang-regression.json --queries tests/bench/strang-transcribed.json --transcripts-from "%APPDATA%\feynmind\feynmind.db"  # the same plus 8 checks on transcribed pages, with the app's vision transcriptions of that book loaded (read-only, no model calls; needs unit 1 processed)
npm run typecheck    # TypeScript check for main/preload and renderer
npm run lint         # ESLint
npm run build        # typecheck, then production build into out/
npm run dist         # build, then package an installer for this OS into release/<version>/
npm run check:deps   # fail if a runtime dependency would be left out of the package (e.g. a peer-only dependency)
npm run smoke        # after dist: check app.asar, copy the app outside the repo, launch it, import and search two fixture PDFs, download the Whisper tiny model, run the speed check, transcribe a clip through a fake microphone, quit
```

Releases: set `version` in package.json, commit, then push a matching tag (`v0.0.2`). `.github/workflows/release.yml` builds Windows, macOS and Linux installers, smoke-tests each one, and only if all three pass uploads them to a draft GitHub Release. CI (`ci.yml`) runs typecheck, lint, `check:deps` and unit tests on every push. To check a release build locally the way CI does: `npm ci && npm run dist && npm run smoke`.

Gotchas:

- `npm test` must go through `scripts/run-vitest.mjs`, not `npx vitest`: better-sqlite3 is built for Electron's Node, and the script also upper-cases the Windows drive letter (`c:` vs `C:` makes Vitest load twice and fail with "failed to find the runner").
- If `npm run dev` fails with `Cannot read properties of undefined (reading 'isPackaged')`, the shell has `ELECTRON_RUN_AS_NODE` set (VS Code's extension host sets it). Unset it and retry.
- electron-builder packages only packages listed under `dependencies`/`optionalDependencies`, never `peerDependencies`. When a runtime library has a required peer (the AI SDK needs `zod`), add the peer to our own `dependencies`. `npm run check:deps` enforces this.
- Never judge a packaged build by launching it from inside the repo: Node's module lookup climbs out of `app.asar` into the repo's `node_modules` and hides missing packages. `npm run smoke` copies the app to a temp folder first.
- The development database lives in Electron's userData folder (`%APPDATA%\feynmind` on Windows), not in the repo. Imported files are copied to `materials/` and the embedding model to `models/` in the same folder.
- Unexpected exits (worker crashes, killed or crashed app, uncaught main-process errors) are logged to `logs/exits.log` in the same folder. Check it first when the app or an import stops on its own.
- Ingestion runs in an Electron utility process (`src/main/ingestion/worker.ts`). Unit tests run with `ELECTRON_RUN_AS_NODE`, so they miss problems specific to that process (PDF.js, for example, takes any non-main Electron process for a browser; see `loadPdfjs`). Check ingestion changes with `npm run test:e2e` and `npm run smoke` too.
- `npm run smoke` downloads the embedding model into its throwaway profile; set `FEYNMIND_SMOKE_MODEL_CACHE` to a folder to reuse it between runs. `FEYNMIND_MODEL_DOWNLOAD=off` stops the app from downloading the model (search is then keyword-only); the e2e tests set it.
- Knowledge jobs (syllabus, unit processing) run in the main process, not the worker, because they need the decrypted key; the worker still renders pages, re-chunks and embeds for them. Every model request goes through `ProviderService.run`, which checks the cache, the session's caps and the rate limiter, and records the ledger (`model_calls`).
- Prompt files start with a header (`version`, `thinking`, `max-output-tokens`, `output-*`). The cache key hashes everything except the `output-*` lines, which only feed estimates: retuning a ratio never re-bills, any other edit invalidates only that prompt's results.
- `FEYNMIND_PROVIDER_REPLAY=<file.json>` makes an unpackaged app answer model requests from a file (see `src/main/providers/replay.ts`); the knowledge e2e test uses it. The test also needs the embedding model on disk: it copies it from `FEYNMIND_SMOKE_MODEL_CACHE` or the development profile, and skips (saying why) when neither has it.
- Vitest hides console output of passing tests here; add `--silent=false` to see it.
- The rate limiter's 10 requests a minute applies to replayed calls too. An end-to-end test that processes a unit and then grades must raise "Requests per minute" in Settings first, or the grade waits up to a minute behind the unit's calls.
- Tutor replies are checked against the passages that were sent: a citation must name a page of them (`[S2 p. 17]`). Recorded live replies in `tests/fixtures/recorded/G-tutor.json` must keep passing `tests/unit/recordedTutor.test.ts`; loosen a check only for harmless variations.
- In `electron-builder.yml`, never put a `files:` list under `win`/`mac`/`linux` that only excludes: electron-builder then packs the whole project folder, old builds included. Keep file filters at the top level, where `${platform}` and `${arch}` work.
- Dictation runs in its own utility process ("FeynMind dictation"), like ingestion: check dictation changes with `npm run test:e2e` and `npm run smoke` too. Audio must never be written to disk or sent anywhere; only the transcript leaves the recognition process.
- The e2e and smoke tests feed the microphone from a WAV with Chromium's `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<file>%noloop`. With the fake-device switch the app skips the macOS permission prompt. On macOS the tests also pass `--disable-features=AudioServiceSandbox`: the fake device reads the WAV inside Chromium's audio service, whose macOS sandbox blocks the file (the v0.1.0 release run failed on this). Never add that switch to the app itself. They copy the Whisper tiny model from `FEYNMIND_SMOKE_MODEL_CACHE`, the test:models cache (`<temp>/feynmind-model-cache`) or the development profile; the dictation e2e test skips (saying why) without it.
- Grading prompts come in pairs: `grade`/`grade-contest` for answers without reasoning and `grade-reasoning`/`grade-contest-reasoning` with it (see the debt note in `docs/tech-plan.md`). An edit to one usually needs the same edit to its partner.
- Native, WASM and worker-thread packages must be listed under `asarUnpack`. Tesseract's worker thread loads its own dependencies from the unpacked folder, so they are unpacked too.