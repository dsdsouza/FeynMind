# FeynMind: tech stack and build plan

The app is a downloadable desktop program built with Electron and TypeScript, storing everything in a local SQLite database.

## Stack

One language, TypeScript, runs the whole app, so contributors need to know only one. Every library below is open source; check each license against the project's MIT license before adopting it.

| Layer | Choice | Why |
| --- | --- | --- |
| App shell | Electron | Installs like a normal app on Windows, Mac and Linux; the full Node.js library ecosystem is available. Tauri gives a smaller download but adds Rust. |
| Interface | React with Vite | Largest contributor pool; the canvas, math and graph libraries all support it |
| Database | SQLite (better-sqlite3) with the sqlite-vec extension | One local file holds everything, including the search index |
| PDF reading | PDF.js | Extracts text per page and renders pages to images for vision models |
| Scanned pages | Tesseract.js | Local text recognition, no API cost |
| Slide decks | Read PowerPoint files directly for text and speaker notes; PDF export for image-heavy decks | No extra software to install |
| Embeddings | Transformers.js with a small local embedding model | Search runs on the user's machine for free |
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

## Build plan

Nine milestones, each ending in something you can run and test. Milestones 1 to 5 make the first public release.

1. **Skeleton.** Electron app with a window, the database, a settings screen, one provider key and one working model call. Automated builds for all three platforms. *Done when:* a downloaded build opens and gets a reply from a model.
2. **Ingestion.** Import PDFs and slide decks, extract text per page, recognize scanned pages, chunk by section, embed, and search. *Done when:* a question about an 800-page textbook returns the right passages with page numbers.
3. **Knowledge.** Extract concepts and prerequisites per section, merge duplicates, parse the syllabus, show cost before running, resume after interruption. *Done when:* one chapter yields a concept graph a subject expert would accept.
4. **Tutor loop.** Diagnostic, standing per syllabus unit, teach then practice then grade, mastery tracking, answers grounded in cited passages. *Done when:* a learner can work through one chapter start to finish.
5. **Dictation.** Reasoning field, local Whisper with a microphone button, and the operating system dictation hint. *Done when:* spoken reasoning appears as text and is graded with the answer. **First public release.**
6. **Retention and roles.** Spaced reviews, interleaving, exam priorities, all five providers, a model per role, spending caps. *Done when:* due reviews appear on the right days and a cheap model grades while a strong one teaches.
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