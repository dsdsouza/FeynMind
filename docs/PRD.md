# PRD: FeynMind

As of 2026-11-15

## Overview

An open-source, local-first app that turns a course's textbooks and syllabus into a personal tutor. It diagnoses what you know, teaches what you don't, and schedules reviews so you keep it. Users bring their own AI provider keys and choose which model does each job.

**Who it is for**

- College students taking a course with assigned textbooks and a syllabus.
- Self-learners with a goal (for example, becoming a quantitative finance engineer) who need a path and materials.

**Goals**

- Learn a course's material faster and retain it longer than classroom study alone.
- Adapt the teaching method to each learner over time, based on measured results.
- Capture how the learner thinks, not only whether the final answer is right.
- Keep each course separate, while showing how learning connects across courses.

**Non-goals**

- Hosting, distributing or downloading textbooks. Users supply their own files.
- A hosted service with accounts. Everything runs on the user's machine.
- Processing raw audio as a learning signal. Speech becomes text before the app uses it.
- Replacing accredited courses, grades or exams.

## Learning principles

Every feature must serve one of these evidence-backed techniques. A feature that serves none is cut.

- **Retrieval practice:** the learner is asked before and after being told.
- **Spaced repetition:** each concept is reviewed on its own schedule, timed to when it is about to be forgotten.
- **Mastery gating:** a concept unlocks only when its prerequisites are solid.
- **Interleaving:** practice mixes earlier topics with new ones.
- **Self-explanation:** the learner explains their reasoning, by typing, dictating or writing it out.
- **Faded worked examples:** full solution first, then partial, then solo.
- **Honest measurement:** the app judges a method by what the learner remembers days later, not by how the session felt.

## User journey

A new user reaches their first lesson in one sitting. There are two entry points: "I have a course" and "I have a goal."

1. **Add models.** Enter one or more provider API keys and assign a model to each role. Defaults are pre-filled.
2. **Choose a teaching preference.** Pick the mode you believe works best, or choose "I don't know, figure it out for me."
3. **Create a session.**
    - *Course:* upload the course's textbooks, slide decks and syllabus, as many files as needed.
    - *Goal:* describe the goal. The research model proposes a pathway and books to get. Check off what you already know, then upload the books.
4. **Take the diagnostic.** A short adaptive quiz runs while the rest of the material is processed in the background.
5. **See where you stand.** The app shows the syllabus path with each unit marked as known, shaky or new.
6. **Learn.** Each session opens with due reviews, then teaches the next concept whose prerequisites are met.
7. **Come back.** The app shows what is due today per session. The learning map shows progress across all sessions.

## Model setup and roles

The app assigns a model to each job, so a cheap model can grade while a strong one teaches.

| Role | Job | Model strength needed |
| --- | --- | --- |
| Teaching | Explains, questions and gives feedback | Strongest available; must read images for the canvas |
| Grading | Scores answers and reasoning against a rubric | Fast, low to mid cost; must read images for the canvas |
| Ingestion | Extracts concepts and prerequisites from the textbook | Cheap, large context |
| Research | Builds goal pathways and suggests books | Cheap; web search preferred |
| Embeddings | Finds the right passages for a question | Small local model, no API cost |
| Dictation | Turns speech into text | Local speech model, or the operating system's dictation |

**Requirements**

- Accept keys from several providers at once. Claude, Gemini, ChatGPT, Qwen and Grok are supported at launch. Any role can use any model from any key.
- List the models each key can reach, and let the user pick per role.
- Flag a model that lacks a needed ability, such as image input for a canvas role.
- Store keys in the operating system's secure storage. Keys are sent only to their own provider.
- Let the user change role assignments at any time without losing progress.
- Show estimated cost before any large job, and running spend per session.

## Sessions, ingestion and diagnostic

Each course or subject is its own learning session, with its own materials, concept graph, progress and history.

**Sessions**

- Create, rename, archive and delete sessions. No limit on the number.
- A session holds any number of materials: textbooks, slide decks, lecture notes and a syllabus.
- Sessions never share teaching context. They share only mastery data, through the learning map and pathways.

**Ingestion**

- Accept PDFs of any size and slide decks, including scanned pages, math and figures. Every uploaded file is read.
- Extract text on the user's machine, page by page. Send only math-heavy or figure-heavy pages to a model.
- Split the book by its own chapters and sections. Every chunk keeps its page numbers.
- Build a concept graph per session: concepts, prerequisite links, and the pages each comes from.
- Process the first syllabus unit first, so learning starts within minutes. It runs once the user approves its estimate.
- Process the remaining units in the background only if the user turns that on (off by default), and always under the session's cap. Otherwise each unit waits until the user asks for it.
- Send only the pages of the unit being processed: transcribe its math-heavy and figure-heavy pages with a vision model, keep the original text, and search the better text.
- Show a review screen per unit: its concepts in learning order, each with definition, prerequisites and page links. The user can rename, merge, delete and relink concepts. The graph never contains a prerequisite cycle.
- Make ingestion resumable after a crash or restart, and never pay twice for the same pages.
- Read the syllabus into topics, order, dates and exam weights. These set the path and the priorities.

**Diagnostic**

- Run a short adaptive quiz across the syllabus before teaching starts.
- Start from the prerequisites and stop probing a branch once the learner misses.
- Output a standing for every syllabus unit: known, shaky or new.
- Let the learner correct the result ("I do know this"), then confirm it with a quick check.

**Grounding**

- Teaching and grading must draw on retrieved textbook passages and cite page numbers.
- When the textbook does not cover a question, the tutor says so before answering from general knowledge.

## Learning loop and teaching modes

The app teaches in three modes and shifts toward whichever one produces the best delayed recall for this learner.

**Learning loop**

- Open each sitting with the reviews that are due.
- Teach the next concept whose prerequisites are met, following the syllabus order and dates.
- Follow teaching with practice, feedback and a scheduled first review.
- Track a mastery estimate and a memory strength for every concept, updated after every answer.
- When an exam date is close, prioritize by exam weight and weakest concepts.

**Teaching modes**

| Mode | What it does | Strongest when |
| --- | --- | --- |
| Explain and show | Clear explanation, worked example, then practice with fading support | The concept is brand new |
| Socratic | Asks first, lets the learner struggle, then guides | The learner has some footing |
| Rapid fire | Short, fast questions with instant feedback | Locking in material and exam preparation |

Visuals, analogies and diagrams are a layer on top of any mode, not a mode of their own.

**Adaptation**

- If the learner picks a mode at onboarding, use it for about 70% of teaching and test the other two with the rest.
- If the learner picks "I don't know," start with an even split and shift toward what works.
- Score each mode by recall of the concepts it taught, measured at later reviews. In-session ratings do not count.
- Learn the best mode per stage (new, developing, consolidating), not one mode for everything.
- Always keep a small share of experimenting, so the app notices when the learner changes.
- Show the learner what the app has found, and let them override it.

## Reasoning, dictation and canvas

Harder questions require the learner to show their thinking. The canvas is always optional.

**Reasoning tiers**

| Question difficulty | Reasoning | Canvas |
| --- | --- | --- |
| Simple | Not asked for | Not offered |
| Moderate | Required: a short explanation of why | Available |
| Hard | Required: a full step-by-step account of the thought process | Recommended, never required |

- The app sets the tier per question from the concept's difficulty and the learner's mastery of it.
- Required reasoning can be typed or dictated. Voice is never the only way.
- Grading covers the reasoning as well as the answer. Feedback names the step where the thinking went wrong.
- A right answer with faulty reasoning does not count as mastery.

**Dictation**

- Reasoning goes into a text field beside the question. The app uses only the text.
- Show a hint next to the field: Windows key + H on Windows, or Dictation on macOS.
- A built-in microphone button uses the dictation model chosen in Settings (and at onboarding, once onboarding exists). It ships in the first release.
- Audio is never stored and never sent to the teaching or grading model.

**Canvas**

- One question per page: the problem at the top, writing space below, like a homework sheet.
- Support stylus, touch and mouse. Offer a typed math editor on the same page for users without a stylus.
- Send the page as an image, with the reasoning text, only on submit or on a hint request.
- Before grading, show "here is what I read" as typeset equations that the learner can correct.
- Save strokes with timestamps, so written steps can be lined up with the dictated reasoning.
- Keep every canvas page in the session history for later review.

## Goal mode and pathways

A learner with a goal but no course gets a pathway: an ordered list of subjects, each with suggested books, that leads to the goal.

**Research**

- The learner states a goal in plain words, such as "become a quantitative finance engineer."
- The research model returns the subjects needed, in prerequisite order, with one or more suggested books per subject.
- Each suggestion gives title, author and edition, so the learner can find it.
- The learner gets the books themselves and uploads them. The app never downloads books.
- Use web search when the provider supports it. Without it, mark suggestions as unverified, since a weak model can invent titles.
- The learner can edit the pathway: add, remove or reorder subjects, or swap a book.

**Pathway and placement**

- Each subject on the pathway becomes a learning session once its book is uploaded.
- The pathway reads mastery from the learner's other sessions. A subject already learned elsewhere is marked as known.
- The learner can also check off subjects they already know by hand. Trust falls as a checked subject nears the highest one checked: early subjects are accepted outright, the one just below the highest gets a single diagnostic question, and the highest gets a fuller check.
- Teaching starts one level below the highest subject checked off, with a short refresher. Someone who checks off calculus and linear algebra starts with a refresher on the level before.
- If the refresher goes well, the app moves on quickly. If it exposes gaps, the app fills them before going further.
- The pathway shows progress toward the goal across all its sessions.

## Learning map

One view shows every concept across all sessions and the links between them.

- Show each session as its own cluster of concepts, colored by mastery.
- Link concepts that are the same or closely related across sessions, such as eigenvalues in linear algebra and in quantum mechanics.
- Opening a concept shows where it was learned, its current strength and its linked concepts.
- Mastery carries across links: a concept learned in one session counts as prior knowledge in another, pending a quick check.
- The map is read-only. It never merges sessions or their teaching context.

## Non-functional requirements

The user's textbooks, progress and keys stay on their machine. The only outbound traffic is model calls to the providers they chose.

- **Local-first:** all data is stored locally. No account, no server, no telemetry by default.
- **Privacy:** textbook content leaves the machine only inside model calls. Keys go only to their own provider.
- **Consent before sending material:** before the first job in a session that sends course material to a provider, show a one-time notice naming the provider, saying that page text and page images will be sent, and noting that free tiers may use submitted content to improve the provider's products. The job does not start until the user confirms.
- **Cost control:** estimate calls and tokens before every job, cache every model result, and let the user set a cap per session. The call cap is the primary cap (it also protects free-tier rate limits); a dollar cap is secondary and needs a known price for the model.
- **Offline use:** reviewing history, the map and past canvas pages works without a connection. Teaching needs one.
- **Portability:** export and import a session, including progress, as a single file. Textbook files are excluded from exports by default.
- **Open source:** the MIT license, a documented provider interface so contributors can add providers, and no bundled copyrighted material.
- **Accessibility:** every required interaction works with keyboard alone. Voice and stylus are never required.
- **Reliability:** an interrupted model call or app crash never loses an answer, a canvas page or ingestion progress.

## Success metrics

The product succeeds if learners remember more, in less study time, than they would without it. The targets below are proposals to confirm.

| Metric | How it is measured | Proposed target |
| --- | --- | --- |
| Delayed recall | Share of concepts recalled (answered correctly, without a hint) at their first review 4 to 13 days after first learning (recall at 7 days) and 21 to 45 days after (recall at 30 days). Reviews that would skip a window are brought forward into it | 85% at 7 days, 80% at 30 days |
| Time to first lesson | Minutes from upload to the first taught concept | Under 10 minutes |
| Grading accuracy | Share of grades the learner does not contest, or that stand after a contest | 95% |
| Handwriting reading | Share of canvas pages needing no correction at "here is what I read" | 90% |
| Adaptation gain | Recall in the learner's best mode versus an even split of modes | Measurable gain within 4 weeks of use |
| Ingestion cost | Model spend to process one 800-page textbook on a low-cost model | Shown up front; within 20% of the estimate |

All metrics are computed locally and shown to the learner. Nothing is reported back to the project.

## Release phases

Each phase ships something usable and proves one thing before the next begins.

1. **Core loop.** One session, one provider key, PDF ingestion, concept graph, diagnostic, and teach-then-quiz with mastery tracking. Typed or dictated answers, with built-in dictation. *Proves:* the learning loop works on a real textbook.
2. **Retention and roles.** Spaced reviews, interleaving, syllabus dates and exam priorities, several keys, and a model per role. *Proves:* learners retain what they learn at 7 and 30 days.
3. **Thinking capture.** Reasoning tiers and the optional canvas with "here is what I read." *Proves:* grading reasoning finds errors that answer-only grading misses.
4. **Adaptive teaching.** The three modes, the onboarding preference, and adaptation scored on delayed recall. *Proves:* the adapted mix beats an even split.
5. **Many sessions and goals.** Multiple sessions, goal mode with research and pathways, placement with a refresher, and the learning map. *Proves:* mastery carries across sessions correctly.

## Open questions

- [ ] Is FeynMind the final name? MindChamber is the alternative.
- [x] Can a learner contest a grade, and does a second model review it? Decided 2026-11-14: yes, once per answer. The objection goes to a second grading pass by the grading model (the same model as the first until roles get their own models in milestone 6); both grades are kept and the second counts.
- [ ] Are the proposed metric targets right?