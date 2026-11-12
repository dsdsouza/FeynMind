# FeynMind

FeynMind is an open-source (MIT), local-first desktop app that turns a course's textbooks, slide decks and syllabus into an adaptive tutor. Users bring their own AI provider keys and assign a model to each role.

Read these before any non-trivial work:

- `docs/PRD.md`: what the product does and why. It is the source of truth for behavior.
- `docs/tech-plan.md`: the stack, module layout, milestones and risks.

If a request conflicts with either document, say so and ask before proceeding. If a decision changes, update the document in the same change.

## Current milestone

**Milestone 1: Skeleton** (see `docs/tech-plan.md`, Build plan).

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
- Write tests alongside the code. A feature is not done until its tests pass and `npm run typecheck` and `npm run lint` are clean.
- Prefer simple, readable code over clever code. Do not add abstractions for needs that do not exist yet.
- Do not leave placeholder implementations or silent fallbacks. If something cannot be finished, say so plainly and leave a clear `TODO` with the reason.
- When behavior depends on a provider's API, check the provider's current documentation instead of relying on memory.
- If a requirement is ambiguous, ask one specific question before building.

## Commands

Fill this in when the project is scaffolded in milestone 1, and keep it current.

```
npm install          # install dependencies
npm run dev          # run the app in development
npm test             # unit tests (no network)
npm run test:e2e     # full-app tests
npm run typecheck    # TypeScript check
npm run lint         # lint
npm run build        # production build
npm run dist         # package installers
```