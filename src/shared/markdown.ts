// Text preparation for TutorText: math delimiters as remark-math reads them, and citations as links.

export const CITE_HREF = '#cite-'

/**
 * Writes math the way remark-math reads it: \( \) as $ $, \[ \] and a line holding only $$...$$
 * as a display block on its own lines. Models use all of these.
 */
export function normalizeMath(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$${m.trim()}$`)
    .replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_, m: string) => `$$\n${m.trim()}\n$$`)
}

/** Turns [S1 p. 12] into a Markdown link that TutorText shows as a button opening the page. */
export function linkCitations(text: string): string {
  return text.replace(/\[(S\d+ p\. [^\]\n]{1,20})\](?!\()/g, (_, cite: string) => `[${cite}](${CITE_HREF}${encodeURIComponent(cite)})`)
}
