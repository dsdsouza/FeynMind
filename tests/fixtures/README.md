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
