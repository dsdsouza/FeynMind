# Test fixtures

Every file here is openly licensed or was written for this project. Never add copyrighted
textbooks or slides. Each fixture is listed with its source, license and how it was made.

## OpenStax Precalculus (CC BY 4.0)

Source: *Precalculus* by Jay Abramson et al., OpenStax, Rice University, 2017,
print-optimized PDF (`Precalculus-OP_9wwF7YT.pdf`, SHA-256
`f0a83745e1ea5b4200bac371afb64615742528e4d31e1e4d241623a38e454e7d`), downloaded from
<https://openstax.org/details/books/precalculus>.

License: Creative Commons Attribution 4.0 International
(<https://creativecommons.org/licenses/by/4.0/>), as stated on the book's copyright page.
The license asks that every redistributed page carry the line
"Download for free at https://openstax.org/details/books/precalculus." The print-optimized
edition does not print it, so it was added to the bottom of every fixture page (as text on
the text pages, drawn into the image on the scanned pages). No other change was made to the
page content.

| File | Book pages (PDF / printed) | What it tests |
| --- | --- | --- |
| `openstax-precalculus-text.pdf` | 17–19 and 37–39 / 1–3 and 21–23 | Text extraction, printed page labels, outline-based chunking. Section 1.2 starts halfway down the fifth page. |
| `openstax-precalculus-scanned.pdf` | 18–19 / 2–3 | Scanned pages: the two pages rendered at 150 DPI in greyscale and saved as image-only PDF pages, with no text layer, so they need OCR. No page labels or outline. |
| `openstax-precalculus-math-figures.pdf` | 824 and 1094 / 808 and A-2 | Page 1 is matrix arithmetic (math-heavy); page 2 is a page of function graphs (figure-heavy). No outline. |

How they were made (once, outside the repository): the pages were copied with pypdf, the
original outline entries and printed page labels for those pages were recreated, and the
attribution line was stamped as a Helvetica text overlay. The scanned pages were rendered with
PDF.js and saved as PDF with Pillow.

## Written for this project (MIT, same as the repository)

| File | What it tests |
| --- | --- |
| `vectors-dot-product.pptx` | PowerPoint import: four slides with speaker notes on every slide. Slide 3 has only a title and a picture (figure-heavy). Built with python-pptx. |
| `syllabus-precalculus.txt` | Syllabus import: a made-up MATH 120 syllabus with a weekly schedule, readings from the OpenStax fixtures' sections (1.1, 1.2, 9.5) and ones they do not contain (9.6), a review week, exams with weights, and policies to ignore. |

## LibriSpeech speech clips (`audio/`, CC BY 4.0)

Source: LibriSpeech ASR corpus by Vassil Panayotov, Guoguo Chen, Daniel Povey and Sanjeev
Khudanpur (<https://www.openslr.org/12>), licensed under Creative Commons Attribution 4.0
International (<https://creativecommons.org/licenses/by/4.0/>). The recordings are LibriVox
readings of public-domain books. Both clips are utterances of speaker 1272 from the dev-clean
set, taken from the Hugging Face sample `hf-internal-testing/librispeech_asr_dummy` at commit
`5be91486e11a2d616f4ec5db8d3fd248585ac07a` (`clean/validation-00000-of-00001.parquet`,
SHA-256 `4e69a06fa5edc90921e5e7e39a7084881f8b3ed9c805c574f4f39c6fde27c603`), decoded from FLAC
and saved unchanged as 16 kHz 16-bit mono WAV. `transcripts.json` holds the corpus's own
transcript of each clip.

| File | Utterance | What it tests |
| --- | --- | --- |
| `speech-9s.wav` | 1272-128104-0007 (9.2 s) | The fake microphone in the end-to-end test and the packaged-app smoke test; recognition accuracy. |
| `speech-29s.wav` | 1272-128104-0004 (29.4 s) | Recognition accuracy and speed on a half-minute take (hard: many proper names); splitting long recordings. |

Neither clip contains mathematical vocabulary; recognition of spoken math is untested.

`tests/unit/whisper-mel-reference.json` (no audio) holds log-mel values of `speech-9s.wav`
computed independently with numpy and librosa, following OpenAI's Whisper recipe.

## Recorded model replies (`recorded/`)

Replies from real Gemini calls (`gemini-3.1-flash-lite`, free tier, 2026-11-13) made by
`tests/live/knowledge.live.test.ts`, with each call's estimate and billed tokens. They were made
only from the files above: the OpenStax pages (so the transcriptions and concept lists derived
from them are adaptations of *Precalculus* by Jay Abramson et al., OpenStax, CC BY 4.0,
<https://openstax.org/details/books/precalculus>), the syllabus written for this project, and the
concept pairs in `tests/models/concept-pairs.json` (written for this project). Unit tests check
that the app's validation accepts them; the token figures set the estimate ratios in `prompts/`.
`toc.txt` is the fixtures' table of contents as the matching prompt sees it (no model call).

| File | What it is |
| --- | --- |
| `A-transcribe-matrix-page.json` | Transcription of the matrix-arithmetic page (prompt version 1). |
| `A-extract-1.1-minimal.json`, `C-extract-1.1-low.json` | Concepts of section 1.1 at thinking "minimal" and "low". |
| `C-extract-1.2-minimal.json`, `C-extract-1.2-low.json` | Concepts of section 1.2 at the two levels. |
| `C-transcribe-figure-page.json` | Figure-page transcription accepted on the third try by version 1's ordering rule (since removed). |
| `E-transcribe-figure-page.json` | The same page with prompt version 3, accepted first time. |
| `B-syllabus-parse.json`, `E-syllabus-parse.json` | The syllabus read with prompt versions 1 and 2. |
| `B-syllabus-map.json` | Units of the version 1 reading matched to `toc.txt`. |
| `D-match-minimal.json`, `D-match-low.json` | 38 pairs with known answers at the two thinking levels (both all correct). |

### Tutor (`tests/live/tutor.live.test.ts`, `gemini-3.1-flash-lite`, 2026-11-14)

Made only from the OpenStax fixture pages above (so the questions, explanations and grades are
adaptations of *Precalculus* by Jay Abramson et al., OpenStax, CC BY 4.0,
<https://openstax.org/details/books/precalculus>) and from text written for this project.

| File | What it is |
| --- | --- |
| `G-tutor.json` | Batch G: diagnostic questions for three concepts, lesson questions and the streamed explanation for "function" and "domain", with every reply (including one the checks of that time rejected, and why) and its tokens. |
| `grading-minimal.json`, `grading-low.json` | The grading benchmark at thinking "minimal" and "low": verdict per case, the grader's criteria and reason, tokens. |
| `contest.json` | Contested grading: a valid objection and a confidently worded invalid one. |
| `grading-reasoning.json` | Batch "reasoning" (2026-11-14, 10 calls): the benchmark's reasoning cases, each graded by the prompt the app chooses, with the verdict, the reasoning judgment and comment, every raw reply and its tokens. |

## Grading benchmark (`tests/bench/grading-cases.json`)

Questions, rubrics and answers written for this project (MIT) about the OpenStax fixture pages
(CC BY 4.0) named in each question; the passages sent with each case are those pages as the app
chunks them. 22 cases: 5 correct, 5 correct in different wording, 4 wrong, 4 partly correct and 4
with a right answer but a wrong reason, each with its expected verdict.
