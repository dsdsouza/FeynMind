# Contributing to FeynMind

Thank you for helping. FeynMind is an early preview, so issues that describe what you tried, what you expected and what happened are as valuable as code.

Before working on something larger than a small fix, open an issue to discuss it. [docs/PRD.md](docs/PRD.md) is the source of truth for what the app does, and [docs/tech-plan.md](docs/tech-plan.md) describes the stack, the module layout and the order in which features are built; work follows the current milestone there.

## Set up

You need [Node.js](https://nodejs.org/) 24 and Git.

```sh
git clone https://github.com/dsdsouza/FeynMind.git
cd FeynMind
npm install        # also rebuilds better-sqlite3 for Electron
npm run dev        # run the app
```

To use a Gemini key during development without saving it in the app, put `GEMINI_API_KEY=...` in `.env.local` (git-ignored). Never commit, print or log a key, and never put one in a test fixture, snapshot or error message.

If `npm run dev` fails with `Cannot read properties of undefined (reading 'isPackaged')`, your shell has `ELECTRON_RUN_AS_NODE` set (VS Code's terminal can set it); unset it and retry. Do not run `npm install` while the dev server is running.

## How the code is organised

- `src/main/` is the background process: all file access, database access, key handling and model calls. Each folder is a module (providers, ingestion, knowledge, learner, tutor, dictation, pathways, storage) that other modules use only through its `index.ts`.
- `src/renderer/` is the interface. It only displays state and collects input; it never touches files, the database, keys or provider SDKs.
- The two talk only through the typed channels in `src/shared/ipc.ts`, exposed by `src/preload/index.ts`.
- All model calls go through `src/main/providers/`. Tutor prompts are plain text files in `prompts/`.
- Database changes are new numbered migrations in `src/main/storage/migrations.ts`; never edit one that has shipped.

## Before you open a pull request

Run these and make sure they pass:

```sh
npm run typecheck
npm run lint
npm test             # unit tests, no network (about a minute)
npm run check:deps   # every runtime dependency will be packaged
npm run test:e2e     # builds the app and runs it with Playwright; no network
```

If your change touches importing, search, dictation or packaging, also build and smoke-test an installer:

```sh
npm run dist && npm run smoke
```

Some end-to-end tests need the local models on disk and skip (saying why) without them; `npm run test:models` downloads them once (no API calls).

Tests make no network calls and use fake providers. Tests that call a real provider are opt-in (`npm run test:live` and the batches listed in `CLAUDE.md`); they cost money, so say in the pull request if you ran any, and how many calls they made.

Keep pull requests small and focused, with tests alongside the code, and explain what you changed and how you checked it.

## Dependencies and licenses

The project is MIT-licensed. Before adding a dependency:

- Check its license, and the licenses of what it pulls in. MIT, Apache 2.0, BSD and ISC are fine. Anything else (GPL, AGPL, LGPL, MPL, proprietary, "non-commercial" and so on) must be raised in an issue first.
- Prefer the libraries already listed in `docs/tech-plan.md`, and say in the pull request why a new one is needed.
- Never copy code from GPL or AGPL projects. Ideas are fine; code is not.
- If it is needed at runtime, it goes under `dependencies` (not only `peerDependencies`), and `npm run check:deps` must pass.

## Course material and test fixtures

Never commit copyrighted textbooks, slides, lecture notes or exams, including pages or screenshots of them, even for a test.

Test fixtures in `tests/fixtures/` must be openly licensed (for example OpenStax books under CC BY 4.0, or LibriSpeech audio) or written for this project, and each one is recorded in `tests/fixtures/README.md` with its source and license. Screenshots in the documentation must show only those fixtures.
