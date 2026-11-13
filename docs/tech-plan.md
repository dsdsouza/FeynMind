# FeynMind: tech stack and build plan

The app is a downloadable desktop program built with Electron and TypeScript, storing everything in a local SQLite database.

## Stack

One language, TypeScript, runs the whole app, so contributors need to know only one. Every library below is open source; check each license against the project's MIT license before adopting it.

| Layer | Choice | Why |
| --- | --- | --- |
| App shell | Electron | Installs like a normal app on Windows, Mac and Linux; the full Node.js library ecosystem is available. Tauri gives a smaller download but adds Rust. |
| Interface | React with Vite | Largest contributor pool; the canvas, math and graph libraries all support it |
| Database | SQLite (better-sqlite3) with the sqlite-vec extension and SQLite's built-in FTS5 | One local file holds everything, including the vector and keyword search indexes |
| PDF reading | PDF.js, with @napi-rs/canvas to render pages in the background process | Extracts text per page and renders pages to images for text recognition and vision models |
| Scanned pages | Tesseract.js, with the English language data bundled (@tesseract.js-data/eng) | Local text recognition, no API cost, works offline |
| Slide decks | Read PowerPoint (.pptx) files directly for text and speaker notes, with fflate (unzip) and fast-xml-parser; PDF export for image-heavy decks | No extra software to install |
| Embeddings | onnxruntime-node and @huggingface/tokenizers running bge-small-en-v1.5, behind an embedder interface so the model can be swapped | Search runs on the user's machine for free. Calling the runtime directly avoids Transformers.js, whose image dependency (sharp) ships LGPL-licensed libvips binaries |
| Dictation | Whisper running locally (whisper.cpp), model downloaded on first use | Private, free, works offline; operating system dictation remains an alternative |
| Model calls | Vercel AI SDK | One interface across providers, with streaming and image input |
| Review scheduling | ts-fsrs | An existing implementation of the FSRS spacing algorithm |
| Canvas | Excalidraw | Pen, touch and mouse drawing under a permissive license |
| Math | KaTeX to display, MathLive to type | Typeset equations and a keyboard math editor |
| Learning map | Cytoscape.js | Built for large concept graphs |
| Key storage | Electron safeStorage | Encrypts keys with the operating system's secure storage |
| Releases | electron-builder with GitHub Actions and GitHub Releases | Free builds and downloads for all three platforms |
| Website | Static site on GitHub Pages | Free hosting |
| Tests | Vitest and Playwright | Unit tests and full-app tests |

## Providers

All five launch providers sit behind one internal interface, so the tutor never knows which one it is talking to. Endpoint details below are from memory; confirm each against the provider's current documentation.

| Provider | Company | How it connects |
| --- | --- | --- |
| Claude | Anthropic | Its own adapter |
| Gemini | Google | Its own adapter |
| ChatGPT | OpenAI | Its own adapter |
| Grok | xAI | Its own adapter, or the OpenAI-style one |
| Qwen | Alibaba Cloud | The OpenAI-style adapter, pointed at Alibaba's endpoint |

- The interface exposes four abilities: generate text, read images, read PDFs directly, and search the web.
- Each model is tagged with the abilities it has. The role picker uses the tags to warn about a mismatch.
- The model list comes from each provider's own listing, so new models appear without an app update.
- A generic "OpenAI-style endpoint" option lets users add other providers, including local models, without code changes.

## Code layout

The interface only displays and collects input. Everything that touches files, keys or models runs in the background process, split into modules a contributor can work on alone.

| Module | Owns |
| --- | --- |
| Interface | Screens: onboarding, session list, lesson, canvas, pathway, learning map, settings |
| Providers | Adapters, model listing, ability tags, key storage, cost tracking |
| Ingestion | File import, text extraction, text recognition, chunking, embeddings, resumable job queue |
| Knowledge | Concept extraction, merging duplicates, prerequisite links, syllabus parsing |
| Learner | Mastery estimates, memory strength, review scheduling, mode statistics |
| Tutor | Choosing the next concept, mode and reasoning tier; prompts; retrieval of passages; grading |
| Dictation | Local Whisper, microphone capture, text handed to the lesson screen |
| Pathways | Goal research, pathway editing, placement and the trust rule for checked subjects |
| Storage | Database schema, migrations, session export and import |

The tutor's prompts live as plain text files in the repository, so contributors can improve teaching without touching code.

### File structure

```
feynmind/
├─ LICENSE
├─ README.md
├─ CLAUDE.md                 # standing instructions for Claude Code
├─ CONTRIBUTING.md
├─ .gitignore
├─ package.json
├─ tsconfig.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ .github/workflows/        # ci.yml, release.yml
├─ docs/                     # PRD.md, tech-plan.md
├─ prompts/                  # tutor prompts as plain text
├─ src/
│  ├─ main/                  # background process
│  │  ├─ index.ts
│  │  ├─ ipc.ts
│  │  ├─ providers/
│  │  ├─ ingestion/
│  │  ├─ knowledge/
│  │  ├─ learner/
│  │  ├─ tutor/
│  │  ├─ dictation/
│  │  ├─ pathways/
│  │  └─ storage/
│  ├─ preload/index.ts       # bridge between the two halves
│  ├─ renderer/              # the interface
│  │  ├─ index.html
│  │  └─ src/                # App.tsx, screens/, components/, state/
│  └─ shared/                # types used by both halves
├─ tests/                    # fixtures/, unit/, e2e/
└─ website/                  # GitHub Pages site
```

## Ingestion

Ingestion runs in a separate background process (an Electron utility process), so the interface never waits on it and a crash in text recognition or the embedding model cannot take down the window.

- **Queue in the database.** Files are processed one at a time in the order they were added. Each page is committed as it finishes; sections are chunked and embedded as soon as all their pages are read, so search coverage grows in file order. After a crash or restart the worker continues from the first unfinished page, section or chunk.
- **Files.** Each imported file is identified by its SHA-256 and copied into the app's data folder under that name, so the same file is never processed twice in a session and later steps work even if the original moves.
- **Pages.** PDF.js extracts text with positions. Pages with almost no text but a large image are rendered and read with Tesseract. Math-heavy and figure-heavy pages are flagged for a vision model (milestone 3); nothing is sent anywhere in milestone 2. Printed page numbers come from the PDF's page labels, or are inferred from the page numbers printed on the pages when a PDF has none.
- **Chunks.** Sections come from the PDF outline, or from detected headings when there is no outline. Chunks never cross a section and record their file, chapter, section and page range.
- **Search.** Keyword (FTS5, BM25) and vector (sqlite-vec, cosine) results are merged with reciprocal rank fusion. Passages that repeat the query's own wording go first: among the top 200 keyword and top 50 vector candidates, a passage whose longest in-order run of query words covers at least half the query's meaningful words (and at least three) ranks ahead of the fused results, closest first. Number words match digits ("three by four" finds "3 by 4") and a plural "s" is ignored.
- **Results open on the match.** Each result opens on the sentences that repeat the query's wording or, failing that, hold the most query words, with the rest of the passage behind "Show the whole passage". The page shown is where those sentences are, found at search time by lining their words up with the stored page text; the passage's own page range is shown beside it when different. A result sharing no words with the query is marked as found by meaning.
- **Search regression set.** `tests/bench/strang-regression.json` holds questions with expected sections and pages for the reference textbook (kept outside the repository). `npm run bench:ingest -- <book> --queries tests/bench/strang-regression.json` fails if any first result is wrong. Run it after any change to extraction, chunking or search.
- **Crashes.** The import worker runs in its own process; if it exits unexpectedly the app keeps running, restarts it (after 1, 5, then 30 s) and it resumes from the database. The Materials screen says so. Unexpected exits are written to `logs/exits.log` in the data folder: the worker's exit code, helper and window processes that go away (with Electron's reason), uncaught errors in the main process (message redacted, stack frames only), termination signals, and a run that never quit cleanly (detected at the next start from a marker file). The log stays on the machine.
- **Embedding model.** `Xenova/bge-small-en-v1.5` (MIT, 384 dimensions, int8 quantized, about 34 MB), pinned to one revision and checked against a SHA-256 after download. It is downloaded on first use into the app's data folder, with visible progress.

### Known limitations

- **English only.** The embedding model and the bundled text-recognition data are English-only. Courses in other languages will get poor search results and poor recognition of scanned pages. Supporting other languages means choosing a multilingual embedding model and downloading other Tesseract language data; not planned yet.
- **PowerPoint.** Only .pptx is read (not the older .ppt). Slides cannot be rendered to images without extra software, so a picture-heavy slide is flagged but cannot be shown as an image; exporting the deck to PDF is the workaround.
- **No Intel Macs (decided 2026-11-13).** The macOS build is Apple silicon (arm64) only. onnxruntime-node 1.31 ships no macOS x64 binary, and the release job runs on an arm64 runner without x64 builds of sqlite-vec and @napi-rs/canvas, so an x64 app would fail to open its database. Supporting Intel Macs would mean an Intel runner and an older ONNX runtime; not planned.
- **Bundled PDF fonts.** The Liberation fonts that ship with PDF.js are GPL-2.0 with a font exception and are left out of the installer. PDFs that rely on non-embedded fonts render with PDF.js's BSD-licensed fallback fonts instead.

## Knowledge

Knowledge jobs (milestone 3) turn one syllabus unit at a time into concepts. They run in the main process, because model calls need the decrypted key, which never leaves it. The ingestion worker still does the computing: reading the syllabus text, rendering pages, re-chunking and embedding.

- **Jobs.** A job is created with an estimate and waits for approval. Its steps (transcribe a page, re-chunk a section, extract a section, match, build) are rows in the database; each step's result is committed in the same transaction that marks it done. An approved job that was running when the app closed resumes at the next start.
- **Prompts.** Each prompt in `prompts/` has a header (`version`, `thinking`, `max-output-tokens`, `output-ratio`). Model results are cached under a hash of the prompt's name and body, the model and the input content, so editing one prompt invalidates only its own results (and, through changed inputs, results built on them). Only output that passed its schema is cached.
- **Transcription.** Math-heavy and figure-heavy pages of the unit are sent as images with their extracted lines numbered; the model returns Markdown with LaTeX, in blocks anchored to the original lines, so sections that share a page still split correctly. The original page text is kept. Chunks of re-transcribed sections hold the transcription, and keyword search also indexes the original words of the same span.
- **Concepts.** One extraction call per section returns concepts with definitions, pages and prerequisite names. Duplicates are merged with local embeddings; only pairs in an unclear similarity band are sent to the model. Prerequisite names are resolved the same way. Cycles are broken by dropping the link that points forward in book order; dropped links are shown and can be restored when that no longer makes a cycle.
- **Cost and limits.** Every request is recorded in a ledger (tokens, outcome). The estimate counts calls not already cached, and recalibrates its output-token ratios from the ledger. Before each call the job checks the session's call cap (and the dollar cap, when the model's price is known); reaching it pauses the job. A rate limiter in the providers module sends one request at a time, honours the provider's retry delay, backs off on overload, and treats an exhausted daily quota as a pause.

## Build plan

Nine milestones, each ending in something you can run and test. Milestones 1 to 5 make the first public release.

1. **Skeleton.** Electron app with a window, the database, a settings screen, one provider key and one working model call. Automated builds for all three platforms. *Done when:* a downloaded build opens and gets a reply from a model.
2. **Ingestion.** Import PDFs and slide decks, extract text per page, recognize scanned pages, chunk by section, embed, and search. *Done when:* a question about an 800-page textbook returns the right passages with page numbers.
3. **Knowledge.** Parse the syllabus into units and map them to book sections, transcribe flagged pages with a vision model, extract concepts and prerequisites per section, merge duplicates, break prerequisite cycles, a review screen per unit, estimates, a call cap (dollar cap secondary), a model cache, rate limiting, `modelForRole`, and resuming after interruption. *Done when:* the user imports their syllabus and confirms its units, runs one unit with the estimate shown first, the review screen shows a concept graph for that unit that the user judges correct (important concepts present, none duplicated, prerequisites pointing the right way, page links opening the right pages), and the actual cost is within 20% of the estimate.
4. **Tutor loop.** Diagnostic, standing per syllabus unit, teach then practice then grade, mastery tracking, answers grounded in cited passages. *Done when:* a learner can work through one chapter start to finish.
5. **Dictation.** Reasoning field, local Whisper with a microphone button, and the operating system dictation hint. *Done when:* spoken reasoning appears as text and is graded with the answer. **First public release.**
6. **Retention and roles.** Spaced reviews, interleaving, exam priorities, all five providers, a screen for assigning a model to each role (milestone 3 adds `modelForRole`, with every role using the one selected model). *Done when:* due reviews appear on the right days and a cheap model grades while a strong one teaches.
7. **Canvas and reasoning tiers.** One-question pages, stylus and typed math, "here is what I read," and the three tiers. *Done when:* a handwritten solution is read correctly and the faulty step is named.
8. **Adaptive modes.** The three teaching modes, the onboarding preference, and adaptation scored on delayed recall. *Done when:* the mode mix shifts measurably after two weeks of simulated use.
9. **Sessions, goals and map.** Multiple sessions, goal research and pathways, placement with the trust rule, and the learning map. *Done when:* a concept mastered in one session is recognized in another. **Version 1.0.**

Build a small set of test materials early: one math textbook chapter, one scanned chapter, one slide deck and one syllabus. Every milestone is checked against them.

## Risks

The two risks most likely to hurt the product are poor math extraction and unreliable grading; both need testing from milestone 2 onward.

| Risk | Handling |
| --- | --- |
| Math and figures extract badly from PDFs | Send those pages as images to a vision model; where the provider reads PDFs directly, send chapter-sized PDFs |
| A model grades a correct answer as wrong | Rubrics built from the source text, a visible reason for every grade, and a way to contest it |
| Ingesting a whole book costs more than users expect | Estimate up front, process the first unit only, cache every result, spending caps |
| Providers change their interfaces or models | One adapter per provider behind a fixed internal interface; model lists fetched live |
| Unsigned apps trigger security warnings on Windows and Mac | Document the workaround at first; signing certificates cost money each year, so decide when the project can fund them |
| Local Whisper is slow on older laptops | Offer a smaller model, and keep operating system dictation and typing as equal options |
| A library's license conflicts with the project's | The project is MIT; check every dependency before adopting it, and never copy code from AGPL or GPL projects |
| The download is large because of Electron and local models | Download the speech and embedding models on first use, not inside the installer |
| The installer grew from 132 MB to 195 MB in milestone 2 (Windows), mostly the ONNX runtime, Tesseract's WASM core and English data, and the canvas library | Only the build's own platform and architecture of the ONNX runtime is packed; the embedding model is downloaded on first use. Tesseract's core still ships several WASM variants that could be trimmed |
