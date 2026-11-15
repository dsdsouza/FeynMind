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
| Dictation | Whisper running locally through the existing onnxruntime-node (English-only tiny, base or small, int8 ONNX), model downloaded on first use | Private, free, works offline; no new native dependency and no installer growth. whisper.cpp was measured and deferred (see Dictation). Operating system dictation remains an alternative |
| Model calls | Vercel AI SDK | One interface across providers, with streaming and image input |
| Review scheduling | ts-fsrs 5.4.2 (MIT, no dependencies), FSRS-6 | An existing implementation of the FSRS spacing algorithm. 6.0.0 (October 2026) was passed over for now: a new major version defaulting to FSRS-7, with a new API and a new dependency |
| Canvas | Excalidraw | Pen, touch and mouse drawing under a permissive license |
| Math | KaTeX to display (through react-markdown, remark-math and rehype-katex, raw HTML off), MathLive to type | Typeset equations and a keyboard math editor. KaTeX is pinned to 0.19.1 by an npm override (rehype-katex asks for 0.16, which advisory GHSA-238p-pmpm-9mq7 covers) |
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
- **Image reading slips.** The vision model can misread small details: on the fixture's figure page it wrote a range as (-1, 1) where the book has [-1, 1]. The original page text is kept and still searchable, and the review screen links every concept to its pages.
- **Estimates before the first run.** Until a session has its own calls to learn from, estimates use the ratios measured on the fixtures and on the first Strang unit. Textbooks unlike them (denser formulas, more figures) can be off by more on the first unit; later units are calibrated from the ledger.
- **Bundled PDF fonts.** The Liberation fonts that ship with PDF.js are GPL-2.0 with a font exception and are left out of the installer. PDFs that rely on non-embedded fonts render with PDF.js's BSD-licensed fallback fonts instead.

## Knowledge

Knowledge jobs (milestone 3) turn one syllabus unit at a time into concepts. They run in the main process, because model calls need the decrypted key, which never leaves it. The ingestion worker still does the computing: reading the syllabus text, rendering pages, re-chunking and embedding.

- **Jobs.** A job is created with an estimate and waits for approval. Its steps (transcribe a page, re-chunk a section, extract a section, match, build) are rows in the database; each step's result is committed in the same transaction that marks it done. An approved job that was running when the app closed resumes at the next start.
- **Prompts.** Each prompt in `prompts/` has a header (`version`, `thinking`, `max-output-tokens`, `output-ratio`). Model results are cached under a hash of the prompt's name and body, the model and the input content, so editing one prompt invalidates only its own results (and, through changed inputs, results built on them). Only output that passed its schema is cached.
- **Transcription.** Math-heavy and figure-heavy pages of the unit are sent as images with their extracted lines numbered; the model returns Markdown with LaTeX, in blocks anchored to the original lines, so sections that share a page still split correctly. The original page text is kept. Chunks of re-transcribed sections hold the transcription, and keyword search also indexes the original words of the same span.
- **Concepts.** One extraction call per section returns concepts with definitions, pages and prerequisite names. Duplicates are merged with local embeddings; only pairs in an unclear similarity band are sent to the model. Prerequisite names are resolved the same way. Cycles are broken by dropping the link that points forward in book order; dropped links are shown and can be restored when that no longer makes a cycle.
- **Cost and limits.** Every request is recorded in a ledger (tokens, outcome). The estimate counts calls not already cached, and recalibrates its token ratios from the ledger, which records each call's estimate before calibration (so a correction that worked is not undone). Before each call the job checks the session's call cap (and the dollar cap, when the model's price is known); reaching it pauses the job. A rate limiter in the providers module sends one request at a time, honours the provider's retry delay, backs off on overload, and treats an exhausted daily quota as a pause.
- **Consent.** Before the first job of a session that sends course material, the user confirms a notice naming the provider and saying that free tiers may use submitted content.
- **Saving the syllabus again (fixed 2026-11-15).** In 0.1.0 saving an edited syllabus deleted and re-inserted every unit, and the cascade removed each processed unit's concept links, its processing job and steps, its "I know this unit" check (with the answers, grades and mastery evidence in it) and its standing override; processing the unit again then created new concepts and left lessons and mastery on the old ones out of reach. Saved drafts now carry each unit's id (filled by position for drafts saved by 0.1.0), and saving updates kept units in place. A unit removed from the draft is deleted; its concepts stay (without that unit), and its confirming check is detached so its answers stay. Importing a different syllabus file still replaces the old syllabus and its units.
- **Measured choices (2026-11-13, 15 calls on `gemini-3.1-flash-lite`, recorded in `tests/fixtures/recorded/`).** Thinking stays at "minimal" for every prompt: "low" gave the same concepts and the same matching answers (38 of 38 at both levels) for 46-60% more output tokens. Input tokens are estimated by counting words, digits and symbols (within -9% to +14% of billed input; characters / 4 was off by up to 55% on pages of numbers). Transcription output is about 1.6 times the extracted text. Merge bands come from `tests/models/thresholds.models.test.ts`: duplicate concepts scored 0.76-0.87 and distinct ones up to 0.84, so only pairs at 0.90 or above merge without the model.
- **First real unit (2026-11-14, Strang chapters 1.1-2.3, 44 billed calls).** Estimated 47 calls, 140,125 input and 44,264 output tokens; used 44 calls, 134,536 input (-4%) and 48,769 output (+10%). Math-page transcription was within 2%; figure pages produced 3.3 times the estimate (the 0.45 figure ratio came from a page that was nearly all graph, so it was dropped), extraction output was 36% below (ratio 0.1 to 0.057), and matching needed 1 call where 4 were estimated (28 unclear pairs in 6 sections; 12 per section assumed, now 5). Refitted on that same run, the estimate would have been 45 calls, about 144,000 input and 48,800 output tokens.

## Tutor

The tutor (milestone 4) runs in the main process like the knowledge jobs. The learner module keeps mastery; the tutor module runs the diagnostic, lessons and grading. Every model request goes through `ProviderService` by role ("teaching" writes questions and explanations, "grading" grades), with the ledger, caps, cache and rate limiter of milestone 3.

- **Grounding.** A lesson retrieves its passages once: the chunks covering the pages the concept was extracted from, then hybrid-search results for its name and definition, up to about 2,500 tokens. They are stored with the lesson and reused by its questions, explanation and grading, so cache keys stay stable. Passages are tagged S1, S2…; the model cites a page as `[S2 p. 17]` (printed page number, or PDF page when there is none). Structured replies citing a page that was not sent are rejected; citation variants (`S2 p.17`, `S2, p. 17`, ranges) are normalised first. When the passages do not cover the concept, the explanation starts with a fixed notice and grades set `outsideSources`; the interface shows both.
- **Diagnostic.** Multiple choice with "I don't know", graded locally (no grading calls). One request writes two questions (a probe and a spare for the confirming check) per concept, eight concepts per request; stored questions are never written again. A concept is asked about only once its prerequisites are known; a correct answer also counts for its prerequisites, a miss marks every dependent concept new without asking. The next question is the eligible concept with the most undecided dependents. At most 15 questions.
- **Standing.** From the concepts with any evidence: known when at least 80% are known or mastered, new when at least 60% are new, otherwise shaky; not assessed without evidence or concepts. "I know this unit" starts a 3-question check on its last concepts in learning order (the spare questions); 2 right raise each concept to at least 0.9. "Treat as new" is accepted without a check.
- **Mastery.** Bayesian Knowledge Tracing per concept: prior 0.2, learning 0.15 per taught answer, slip 0.1, guess 0.25 for multiple choice, 0.15 for opening and unaided questions, 0.3 guided, 0.2 partial; a partly correct answer counts half. Bands: new < 0.3 ≤ shaky < 0.6 ≤ known. Mastered needs at least 0.95 and a correct unaided answer in the lesson, with the last answer correct; the diagnostic or the opening question alone never masters a concept. The estimate is a replay of an append-only evidence log using each answer's final grade, so a contest only recomputes it. Typical paths: one correct diagnostic answer gives 0.47 (shaky); corroborated by a correct answer on a dependent concept, 0.76 (known), after which a correct opening answer passes 0.9 and the lesson offers to skip to an unaided question. A new learner who answers opening, guided, partial and unaided correctly goes 0.66, 0.875, 0.974, 0.996; one who misses the opening question and then gets all practice right goes 0.17, 0.48, 0.84, 0.97 (`tests/unit/mastery.test.ts` checks these figures).
- **Lesson.** Opening question, then the explanation and a worked example (streamed, written once per concept and stored), then a guided question (full scaffold), a partial one (first step), and unaided questions until mastered: three are written with the lesson, three more on request (one call). The next concept is the earliest in syllabus and learning order that is not yet learned and whose prerequisites are all mastered (when an exam is close, the one in its units with the most weight and least mastery; see Retention); others are locked.
- **Reasoning.** Every lesson question has an optional "Your thinking" field beside the answer, typed or dictated. It is stored with the answer (same row, before grading) and drafted like the answer. An answer with reasoning is graded by `grade-reasoning` (and contested by `grade-contest-reasoning`): the rubric is judged on the answer and the reasoning together, and the grader also judges the reasoning as sound, flawed or none (no reasoning to judge), naming the faulty step. It is told to ignore dictation artifacts (filler words, repeats, numbers as words, similar-sounding math terms). Flawed reasoning caps the verdict at partly correct, so a right answer reached by faulty thinking never counts toward mastery. Answers without reasoning use the unchanged `grade` prompt. Reasoning tiers (required reasoning by difficulty) come in milestone 7.
- **Grading.** The rubric (one to four criteria with points and an "essential" flag) is written with the question from the passages. The grader decides each criterion (yes, partly, no) with quoted evidence and a reason; the app computes the verdict: correct needs a score of at least 0.85 and every essential criterion fully met, below 0.4 is incorrect, anything else partly correct. A right answer with a wrong reason is therefore partly correct. "I don't know" is graded locally. A learner can contest a grade once: the objection is saved, a second grading sees it, and both grades are kept; the second counts.
- **Reliability.** Every answer and objection is saved before its grading request starts. A lesson reopened after a crash grades what is still waiting (a reply that arrived before the crash comes from the cache) and restarts an explanation that was cut off. The step, the current question and the draft answer are stored, so the app reopens on the lesson where it stopped. Reaching the call cap leaves answers saved; the lesson screen offers to raise the cap and then grades them.
- **Cost.** About 6 calls per concept (questions 1, explanation 1, four grades) plus contests and extra questions; the diagnostic costs one call per eight concepts. Each lesson and the diagnostic show their estimate before the first call, and the lesson screen shows the course's running total.
- **Measured choices (2026-11-14, 58 calls on `gemini-3.1-flash-lite`, recorded in `tests/fixtures/recorded/`).** Teaching prompts stay at thinking "minimal": explanations were grounded, cited only pages that were sent and worked correct, non-trivial examples. Grading uses "low": on the 22-case benchmark (`tests/bench/grading-cases.json`) "minimal" agreed with the expected verdict 21 times (43,345 tokens in, 4,178 out) and "low" 22 times (43,345 in, 7,086 out including 2,845 thinking); the miss at "minimal" marked an arithmetic slip as not met instead of partly met. That is about 130 more output tokens per grade (about $0.0002 at the paid price). Contested grading changed the grade for a valid objection and kept it for a confidently worded invalid one.

### Known limitations

- **Two grading prompts (debt, 2026-11-14).** `grade` and `grade-reasoning` (and their contest versions) overlap. They were kept apart so that answer-only grading stays byte-for-byte what the 22-case benchmark measured, because rerunning it was outside milestone 5's call budget. Merge them in a later milestone, when the full benchmark can be rerun on the merged prompt.
- **Grading waits behind other calls.** The rate limiter sends one request at a time at the configured rate (10 a minute by default). While a unit is being processed, a lesson's grade can wait up to a minute; the lesson shows the answer as saved meanwhile.
- **Benchmark size.** 22 cases on six questions from two chapters is enough to catch gross errors, not to measure a 95% grading accuracy. The rubrics in the benchmark are hand-written; generated rubrics may be weaker.

## Dictation

Dictation (milestone 5) turns speech into text on the user's machine. Audio never leaves memory: it is not written to disk, not sent over the network and not given to any model provider; only the final text is used.

- **Engine.** Whisper's English-only models, exported to ONNX by onnx-community (OpenAI's weights, MIT; exports Apache-2.0), run through the onnxruntime-node the app already ships for embeddings. The app computes the log-mel features itself (checked against an independent numpy and librosa reference to four decimals in `tests/unit/whisperMel.test.ts`) and decodes greedily with a key/value cache, without timestamps. Only the decoder outputs that are used are fetched: copying the cached encoder values out tripled each step's time. Recordings over 30 s are split at the quietest moment, silence is never sent to the model (Whisper invents words for it), and non-speech markers are removed.
- **Models.** Tiny (44 MB download), base (80 MB) and small (252 MB), int8 encoder and decoder, each pinned to a commit with a SHA-256 per file, downloaded on first use into the data folder with visible progress. Tiny is the default; base and small can be chosen in Settings, which also offers "Check speed on this computer". There is no automatic speed check: it would mostly run on mains power and pick a model too slow for the same machine on battery.
- **Process.** Recognition runs in its own Electron utility process ("FeynMind dictation", `src/main/dictation/worker.ts`), started on first use; the model loads while the learner starts talking. If the process exits unexpectedly, the exit goes to `logs/exits.log`, the lesson says recognition is restarting, and it is restarted after 1, 5, then 30 s; a segment that was being transcribed is sent once more, and fails with "please record that part again" after that. After three restarts in a row it gives up and suggests a smaller model or typing.
- **Capture and privacy.** The lesson screen records with `getUserMedia` into a 16 kHz `AudioContext` and hands the samples, in quarter-second chunks, over IPC to the main process, which passes them to the recognition process. Audio is held in memory only and dropped once transcribed: it is never written to disk, never sent over the network and never passed to a model provider; the dictation end-to-end test checks that no audio file appears in the profile. A ScriptProcessorNode is used rather than an AudioWorklet, because a worklet module would have to be fetched by URL from a `file://` page under the content security policy; if Chromium removes the node, move to a worklet served from the app's own protocol.
- **Permissions.** The session's permission handlers grant `media` only for audio, only to the app's own window showing the app's own page; every other request (camera, screen, notifications, location, devices and the rest) is denied (`src/main/permissions.ts`). On macOS the app asks for microphone access through `systemPreferences` before the first recording, and the build carries `NSMicrophoneUsageDescription`. A denied or missing microphone gets a message naming the setting to change, and typing always works.
- **Interface.** Both lesson fields ("Your answer" and "Your thinking") have a microphone button; Ctrl+Shift+Space starts and stops dictation in the focused field (the thinking field when neither has focus) and Esc discards it. While listening the lesson shows the elapsed time and a level meter, then "Transcribing…"; the field is read-only meanwhile and submitting waits. The text goes in at the cursor and stays editable. A recording stops at five minutes. Next to the fields the lesson names the operating system's own dictation (Windows key + H on Windows, Dictation on macOS; nothing on Linux). Pressing the microphone before a model is downloaded offers the download with its size and progress.
- **Speed check.** "Check speed on this computer" transcribes a half-minute LibriSpeech clip shipped with the app (CC BY 4.0, attribution beside it in `resources/speech-check/`) with the selected model and shows the time and what it heard. It adds 0.7 MB to the installer.
- **Segments.** While the learner speaks, the recording is cut at pauses (0.6 s of quiet relative to the speaker's level) into segments of at least 8 s, or at the quietest moment by 25 s, and each is transcribed at once with the text before it as context. After stop, only the last segment is left to transcribe.

### Measurements (2026-11-14, 16-core Windows laptop)

Word error rate (WER) is against LibriSpeech's transcripts; the 29 s clip is hard on purpose (many proper names). Times are for transcription only; loading takes 1 to 6 s once per app session.

| Model (ONNX, int8) | 29.4 s clip, mains | 29.4 s clip, battery | 9.2 s clip, mains / battery | WER, 29 s / 9 s |
| --- | --- | --- | --- | --- |
| Tiny | 3.1 s | 9.1 s | 1.2 / 3.3 s | 10.3% / 5.3% |
| Base | 10.6 s | 16.0 s | 3.6 / 6.0 s | 11.8% / 5.3% |
| Small | 18.3 s | 28.1 s | 8.8 / 14.0 s | 10.3% / 5.3% |

- **Sustained speed is a fraction of burst speed.** Every process ran at full speed for about 1.5 s, then settled at roughly a quarter: base's encoder took 280 ms, then about 1,250 ms on mains and 2,200 ms on battery; its decoder 22 ms per token, then 60 to 90 ms. Raising process priority did not change it; it is the CPU's power limit.
- **Base missed the 8 s target** for 30 s of speech on mains (10.6 s), so tiny is the default. A float32 decoder made base 8.5 s on mains for a 234 MB download; the fp16 decoder export does not load in ONNX Runtime 1.31 (malformed graph).
- **Segmenting**, on two LibriSpeech takes of 143 s and 118 s on mains: with an 8 s minimum, WER rose by 1.8 and 0.7 points for tiny and by 0.6 and 1.8 for base, and the wait after stop was about 2 s (tiny) and 3 s (base). A 4 s minimum cost tiny up to 4.0 points, so 8 s was chosen.

### whisper.cpp (measured, deferred)

`@fugood/whisper.node` 1.1.3 (the latest stable release; 1.2.0 is at release candidates), MIT, prebuilt for Windows x64 (CPU, Vulkan), Apple silicon (CPU and Metal) and Linux x64 (CPU, Vulkan), with q5_1 GGML models, measured on the same clips and laptop on mains power:

| Model | CPU, 29.4 s clip | GPU (Vulkan, Intel integrated), 29.4 s clip | WER, 29 s / 9 s |
| --- | --- | --- | --- |
| Tiny | 7.7 s | 0.6 s | 16.2% / 5.3% |
| Base | 16.3 s (greedy, 8 threads) | 0.9 s | 13.2% / 5.3% |
| Small | 88 s | 2.8 s | 16.2% / 5.3% |

- On the GPU it is about ten times faster than ONNX on the CPU. The very first GPU run took 10.5 s while the driver prepared itself; later processes started at full speed. On the CPU it is 1.5 to 5 times slower than ONNX, and its q5_1 models were somewhat less accurate on the long clip.
- A diagnostic run with the binding's native log listener switched on ran for 15 minutes on about 1.5 cores without finishing and was stopped; the cause is unknown.
- The Windows install also brings a CUDA variant (125 MB) containing NVIDIA's runtime libraries, which are licensed under NVIDIA's terms, not MIT. It would have to be left out of the package, as would a WASM build (9 MB) and bundled whisper.cpp sources (12 MB). The installer would grow by about 6.5 MB on Windows.
- CI runners have no GPU, so the GPU path cannot be tested in CI; it would need a manual check on each platform.
- **Decision (2026-11-14): ONNX only for milestone 5.** Revisit whisper.cpp, as a second engine behind the same transcriber interface for machines with a working GPU, if users report dictation as too slow or too inaccurate.

### Known limitations

- **English only**, like search and text recognition.
- **Math vocabulary is untested.** The fixture clips are read English prose; no recording of spoken mathematics was available. The grader is told to read similar-sounding math terms as the student evidently meant them, and the text is shown and editable before it is submitted.
- **Slow on battery.** On the test laptop, base needs about half a minute of computing per minute of speech on battery; segmenting hides most of it while the learner talks.
- **Unsigned macOS build and the microphone (untested on a Mac).** macOS ties microphone permission to the app's code signature. The unsigned (ad-hoc) build gets a new identity with every build, so macOS may ask again after each update and leave stale FeynMind entries in System Settings › Privacy & Security › Microphone. Gatekeeper may report a downloaded build as damaged before it ever asks (right-click › Open, or `xattr -dr com.apple.quarantine` on the app). Started from Terminal, the permission is attributed to Terminal. If the app is later signed with the hardened runtime, it needs the `com.apple.security.device.audio-input` entitlement, or the microphone is silently denied. CI only exercises Chromium's fake capture device, which bypasses macOS's permission system, so a real microphone on a Mac has to be checked by hand.
- **Fake microphone in tests.** The end-to-end and smoke tests replace the microphone with Chromium's fake capture device fed from a fixture WAV; with that switch present the app skips the macOS permission question (a CI machine cannot answer it). On macOS the fake device reads the WAV inside Chromium's sandboxed audio service, and that sandbox blocks the file, so the macOS test runs also lift the audio service's sandbox (`--disable-features=AudioServiceSandbox`); the app itself keeps it, since the sandbox allows real microphone capture.

## Retention

Retention (milestone 6a) schedules a review of every learned concept for when it is about to be forgotten. Scheduling is the learner module's (`src/main/learner/`: `days.ts`, `schedule.ts`, `queue.ts`); sittings, review questions, the re-teach and mixing into lessons are the tutor module's (`src/main/tutor/reviews.ts`).

- **Scheduler.** ts-fsrs 5.4.2 with FSRS-6's default weights, desired retention 0.9, maximum interval 365 days, fuzz off (due days are predictable and testable) and short-term learning steps off (the lesson itself is the learning step). The scheduler only sees whole study days: each day is passed as noon UTC on its date. A concept's memory state is the replay of its review log (`review_events`), with each event rated from the attempt's final grade, so a contest recomputes it; `review_cards` caches the result. First mastery records first learning automatically. Concepts mastered in 0.1.0 were backfilled by migration 6 at their `mastered_at`.
- **Ratings.** First learning, from the lesson: Easy when the opening question (before teaching) and every later answer were right; Hard when an unaided answer, or more than one practice answer, was not fully right; otherwise Good. A review: Again when wrong, "I don't know", flawed reasoning (whatever the verdict), or partly right after a hint; Hard when partly right without a hint, or right only with a hint; Good when right without a hint. A review never gives Easy: grades measure correctness, not fluency, and a wrongly earned Easy stretches the interval until the concept is forgotten. Help is "Show a hint" (the variant's hint, or the concept's definition for lesson questions).
- **Mastery and memory strength.** Two separate quantities, both shown. Mastery (Bayesian Knowledge Tracing) is whether the concept was learned and does not decay; memory strength (FSRS stability, and the chance of recall on a day) decays and drives scheduling and priorities. A review answer feeds both: mastery gets an answer of kind 'review' (guess 0.15, 0.3 after a hint, no learning step).
- **A lapse** (a review rated Again): FSRS lowers stability and the concept comes back the next study day (FSRS alone would wait two). The mastery estimate is updated by Bayes, then capped at 0.75 (known, not mastered), and mastery is cleared. It is mastered again when the estimate reaches 0.95 with a correct answer without help since the lapse and the last answer correct: a correct re-teach check takes 0.75 to 0.955; a missed one leaves 0.37. Until then, new lessons on concepts that need it wait; lessons already started go on, and mastered dependents keep their own schedules (their own reviews measure them). A learned concept otherwise stays mastered, even through a partly right review (Hard is a pass).
- **Re-teach.** After a lapse the sitting offers a short re-teach (`prompts/reteach.txt`, streamed, at most 200 words, cited, naming what went wrong and solving the missed question), then a check question chosen like a review question. The check counts toward mastery, not the schedule. After a missed check the lesson's stored explanation is shown, without a call.
- **Due reviews first.** A study day runs from 04:00 to 04:00 local time. Due and overdue cards, minus concepts with an answer waiting for its grade and concepts done today, are cut to what is left of the daily limit (default 25 per course, 1 to 200): when an exam is close, due concepts in its units first; then other due concepts, lowest chance of recall first; then early "exam prep" reviews. Due reviews beyond the limit are held, keep their due day, and FSRS uses the real time elapsed when they are reviewed; the Learn screen says when the backlog is cleared at the limit. New lessons wait until today's due reviews are done or skipped for the day.
- **Review questions.** Recall only: the stem, without explanation, scaffold or passages, and without naming the concept until it is answered. A review asks one of the concept's stored opening or unaided lesson questions or earlier review variants, never the one asked at its previous review nor one answered in the last 7 days; never-answered ones first, then the one answered longest ago. When none is eligible, one call (`prompts/review-questions.txt`) writes three variants from the lesson's stored passages, told every question already asked; they are cached and stored as unaided questions with purpose 'review'. Offline, the question seen longest ago is asked instead.
- **Mixing.** A sitting's reviews change unit at every step when they can: each step takes the highest-priority remaining review from a unit other than the previous one's. A lesson mixes in at most one question from an earlier concept, between the partial and the first unaided question: learned, not lapsed, not due today and not reviewed today, another unit preferred, lowest recall first, and only below 93% recall. It is a real (early) review. (97% was planned; the 90-day simulation showed it pulled in a concept learned the day before and pushed its schedule out.)
- **Exam priorities.** An exam is close from 14 days before it to its day. Its units come from the syllabus (the whole course when it names none); each unit's share is its exam weight normalised over the exam's units (units without one get the average; equal shares when none is given). Priority is share × weakness: 1 − predicted recall on the exam day for learned concepts, 1 − mastery for the rest. It reorders due reviews, adds early reviews of concepts below 90% predicted recall on the exam day, and picks the next lesson from the exam's units. Every recommendation carries structured reasons ("Due today", "Missed last time", "Quiz 5 in 6 days · equal weight (the syllabus gives none) · predicted recall on the day 64%", "Next in the syllabus") turned into text in `src/shared/reviews.ts`. Exams are edited in place on the Learn screen (`exams:update`), never by saving the syllabus again.
- **Measurement.** Delayed recall (PRD success metrics) is the share rated Good among each concept's first review 4 to 13 days after first learning (recall at 7 days) and its first review 21 to 45 days after (recall at 30 days). FSRS alone often steps over these windows (an all-Good path reviews on days 3, 17 and 74), so when a concept's next review would jump past a window it has no review in yet, it is brought forward to day 7 or day 30 after learning: about one extra review per concept in the first month. Scheduling aims at 90% recall, so the figures sit near it by design. The Progress tab shows both, reviews per day, the next 14 days and every concept's memory, computed from local tables.
- **Time.** All scheduling reads an injected clock (`src/main/clock.ts`), never the system time. It never goes back before the latest moment scheduling stored (kept in settings), so a clock that moves backwards cannot reorder reviews; the Learn screen says when the system clock is behind. Study days are worked out with Intl in the current zone, which the window reports at start and on focus (Node keeps the zone it started with); a review keeps the study day it was given. In development builds Settings has a date control (+1, +7, +30 days, reset); production bundles leave it out (`import.meta.env.DEV`), the main process refuses its channel in packaged builds, and `npm run smoke` checks both. `FEYNMIND_CLOCK_OFFSET_DAYS` moves the date for end-to-end tests (unpackaged only).
- **Offline.** What is due, history and progress read local data only. A review answer is saved before grading; offline (Electron's `net.isOnline()`, or a network or timeout error from the provider) it stays saved and the sitting moves on. Waiting answers are graded at startup, when the window reports it is back online, and after 1, 2 and 5 minutes; a late grade schedules from the day the answer was given.
- **Cost.** A review costs one grade (the unchanged grading prompts); new variants one call per concept with none eligible; a re-teach two calls (explanation and check), shown when offered; a mixed-in lesson question one grade. The Learn screen shows the sitting's calls and tokens before it starts. Everything goes through `ProviderService.run`, so the cache, ledger, call cap and rate limiter apply; reaching the cap leaves answers saved.
- **Measured choices (2026-11-15, 13 calls on `gemini-3.1-flash-lite`, recorded in `tests/fixtures/recorded/R*.json`).** Review variants for "function", "domain" and "matrix addition": every reply passed the checks first time, cited pages that were sent, differed from the questions already asked and gave hints that point without answering; output 736 to 849 tokens against an estimate of about 800. Re-teaches after three wrong answers (one with flawed reasoning): 110 to 171 words, cited, the flawed one naming the faulty step; output 142 to 262 tokens (the estimate's base was lowered from 320 to 230). The unchanged `grade` prompt on six written answers to the generated variants (`tests/bench/review-grading-cases.json`: 2 right, 2 partly right, 2 wrong) agreed with all six expected verdicts. The grading prompts were not edited: rerunning their benchmarks (44 calls) did not fit this milestone's budget of 30.
- **Tests.** A 90-day simulation (`tests/unit/simulation.test.ts`) learns three concepts, misses one review and takes a week off, and checks every review day against values worked out from the rules. The migration is tested on a 0.1.0-shaped database and, opt-in (`FEYNMIND_MIGRATION_DB`), on a copy of a real one.

### Known limitations

- **Review and re-teach answers are attached to lessons (debt, 2026-11-15).** The shipped CHECK constraints allow `questions.kind` only the five lesson kinds and require every attempt to belong to a lesson or a diagnostic. Rebuilding those tables needs foreign keys switched off outside a transaction, and dropping `attempts` with them on would delete its grades and mastery evidence, so migration 6 only adds columns: review variants are unaided questions with purpose 'review', and review and re-teach answers are attached to the reviewed concept's own lesson with purpose 'review' or 'reteach'. Every lesson query filters on purpose 'lesson'; `tests/unit/reviews.test.ts` checks that lesson progress, resume and the mastery replay are unchanged with such answers attached. The proper fix: a future migration that rebuilds `attempts` and `questions` without those constraints (a `kind` of 'review', a nullable lesson with a `review_item_id`), run with foreign keys off in a migration step outside the per-migration transaction, then drop the purpose workaround.
- **Default FSRS weights.** Every learner gets FSRS-6's default weights; fitting them to the learner's own reviews needs months of data and an optimizer (not shipped).
- **Time zone changes** are picked up when the window reports them (start, focus, back online); Chromium's own detection of a change was not tested on every platform.
- **Concepts known but not learned.** Concepts known from the diagnostic or "I know this unit" get no review schedule until their lesson masters them.
- **The re-teach** is offered in the sitting where the review was missed (and from today's last sitting on the Learn screen); a miss the next day offers it again.
- **The date control's channel** is on the bridge in every build; packaged builds refuse it in the main process and their renderer has no control for it.

## Build plan

Nine milestones, each ending in something you can run and test. Milestones 1 to 5 make the first public release. Milestone 6 is built in two parts, 6a and 6b (split 2026-11-15).

1. **Skeleton.** Electron app with a window, the database, a settings screen, one provider key and one working model call. Automated builds for all three platforms. *Done when:* a downloaded build opens and gets a reply from a model.
2. **Ingestion.** Import PDFs and slide decks, extract text per page, recognize scanned pages, chunk by section, embed, and search. *Done when:* a question about an 800-page textbook returns the right passages with page numbers.
3. **Knowledge.** Parse the syllabus into units and map them to book sections, transcribe flagged pages with a vision model, extract concepts and prerequisites per section, merge duplicates, break prerequisite cycles, a review screen per unit, estimates, a call cap (dollar cap secondary), a model cache, rate limiting, `modelForRole`, and resuming after interruption. *Done when:* the user imports their syllabus and confirms its units, runs one unit with the estimate shown first, the review screen shows a concept graph for that unit that the user judges correct (important concepts present, none duplicated, prerequisites pointing the right way, page links opening the right pages), and the actual cost is within 20% of the estimate.
4. **Tutor loop.** Diagnostic, standing per syllabus unit, teach then practice then grade, mastery tracking, answers grounded in cited passages. *Done when:* a learner can work through one chapter start to finish.
5. **Dictation.** Reasoning field, local Whisper with a microphone button, and the operating system dictation hint. *Done when:* spoken reasoning appears as text and is graded with the answer. **First public release.**
6. **Retention and roles**, in two parts:
    - **6a. Retention.** Review scheduling with ts-fsrs, due reviews first in each sitting with a daily limit, review questions that vary, a short re-teach after a lapse, interleaving, exam priorities with reasons shown, delayed-recall measurement on a progress view, an injectable clock with a development-only date control, and offline review answers graded later. Every role still uses the one selected Gemini model. *Done when:* concepts learned earlier show due dates, moving the development clock forward makes the right reviews appear on the right days, a sitting opens with due reviews mixed across topics, a failed review brings the concept back sooner and offers a re-teach, setting an exam date close to today changes the recommendations with reasons shown, and progress from 0.1.0 survives the upgrade.
    - **6b. Providers and roles.** All five providers, a screen for assigning a model to each role (milestone 3 adds `modelForRole`, with every role using the one selected model), and fallback when a provider fails. *Done when:* a cheap model grades while a strong one teaches.
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
| Local Whisper is slow on older laptops | Tiny is the default, larger models are opt-in with a speed check, recordings are transcribed in segments while the learner speaks, and operating system dictation and typing stay equal options. whisper.cpp on the GPU is the measured fallback plan (see Dictation) |
| A library's license conflicts with the project's | The project is MIT; check every dependency before adopting it, and never copy code from AGPL or GPL projects |
| The download is large because of Electron and local models | Download the speech and embedding models on first use, not inside the installer |
| The installer grew from 132 MB to 195 MB in milestone 2 (Windows), mostly the ONNX runtime, Tesseract's WASM core and English data, and the canvas library | Only the build's own platform and architecture of the ONNX runtime is packed; the embedding model is downloaded on first use. Tesseract's core still ships several WASM variants that could be trimmed |
