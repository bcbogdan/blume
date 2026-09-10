import { normalizeRoute } from "../core/base-path.ts";
import { buildOramaIndex, queryOramaIndex } from "../search/orama-index.ts";
import type { OramaDoc } from "../search/orama-index.ts";

/** A chat message as posted by the Ask AI island (`{ role, content }`). */
export interface AskMessage {
  content: string;
  role: string;
}

/** The current-page hint the island forwards so the endpoint can prioritize it. */
export interface AskPage {
  path?: string;
}

/**
 * The self-contained snapshot the grounded Ask AI endpoint imports. Bundles the
 * search documents so retrieval works regardless of the configured search
 * provider and needs no filesystem access at request time. Serialized to
 * `generated/ask-data.json` and built by {@link buildAskData}.
 */
export interface AskData {
  /**
   * The site's `i18n.defaultLocale`, when i18n is configured. Selects a
   * word-segmenting Orama tokenizer for every non-Latin script, so retrieval
   * can match CJK, Cyrillic, Greek, Hebrew, or Devanagari content.
   */
  defaultLocale?: string;
  documents: OramaDoc[];
  site: string | null;
}

/** Documents retrieved per question and injected into the system prompt. */
const MAX_RESULTS = 6;
/** Characters kept per injected excerpt. */
const EXCERPT_CHARS = 2000;
/** Overall cap on injected documentation characters. */
const CONTEXT_BUDGET = 10_000;
/**
 * Smallest excerpt worth injecting. A long page pushed under a tiny residual
 * budget would get a full `## Title (/route)` heading over a fragment of a few
 * dozen characters — a section the model is invited to cite but that grounds
 * nothing. Short pages that fit whole are still injected below this floor.
 */
const MIN_EXCERPT_CHARS = 200;

/**
 * How much retrieved documentation a question carries (the `ai.ask.retrieval`
 * config). Every field falls back to the built-in default, so a partial object
 * only changes what it names. Injected characters dominate time-to-first-token
 * on a self-hosted backend, and the three knobs aren't interchangeable: the
 * budget caps the total, `excerptChars` decides how deep into one long page the
 * excerpt reaches, and `maxResults` decides how many pages retrieval adds (the
 * page the reader is viewing is injected on top of them).
 */
export interface AskRetrievalOptions {
  /** Overall cap on injected documentation characters. Defaults to `10000`. */
  contextBudget?: number;
  /** Characters kept per injected excerpt. Defaults to `2000`. */
  excerptChars?: number;
  /**
   * Documents retrieved per question. Defaults to `6`. The current page is
   * injected in addition when it isn't among the hits.
   */
  maxResults?: number;
}
/** Chars of lead-in kept before the matched region, for heading/sentence context. */
const EXCERPT_LEAD = 160;

/**
 * Common conversational words dropped locally for Ask retrieval and excerpt
 * selection, so filler doesn't outrank the meaningful terms.
 */
const STOPWORDS = new Set([
  "about",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "my",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "use",
  "used",
  "using",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

/** Keep internal apostrophes so contractions don't contribute isolated suffixes. */
const TERM = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;

// Orama keeps these connectors within tokens; stripping part of `is_ready` or
// `on-call` would turn a searchable identifier into a different query.
const RETRIEVAL_TOKEN = /[\p{L}\p{M}\p{N}_'’-]+/gu;

// Single characters in unspaced scripts must still match within running text.
const UNSPACED_CHARACTER =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]$/u;

/**
 * Word-shaped pieces of a query, NFC-normalized and lowercased. Languages
 * written without spaces (the CJK/Thai sites the Orama tokenizer goes out of
 * its way to support) have no delimiter for a regex to split on, so the query
 * is cut with `Intl.Segmenter` where available — otherwise every excerpt
 * window silently degrades to the head of the page. The regex fallback covers
 * runtimes without the segmenter and still handles spaced scripts correctly.
 */
const hasSegmenter = (
  segmenter: typeof Intl.Segmenter | undefined
): segmenter is typeof Intl.Segmenter => typeof segmenter === "function";

const segmentQuery = (query: string): string[] => {
  const lowered = query.normalize("NFC").toLowerCase();
  if (!hasSegmenter(Intl.Segmenter)) {
    return lowered.match(TERM) ?? [];
  }
  const pieces: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  for (const segment of segmenter.segment(lowered)) {
    if (segment.isWordLike) {
      pieces.push(segment.segment);
    }
  }
  return pieces;
};

/** Distinct, meaningful lowercase terms from a query (drops stopwords). */
const queryTerms = (query: string): string[] => {
  const terms = segmentQuery(query).flatMap((piece) => piece.match(TERM) ?? []);
  return [...new Set(terms)].filter((term) => !STOPWORDS.has(term));
};

const retrievalQuery = (query: string): string => {
  let meaningful = false;
  // Replace only noise, preserving punctuation and adjacency: joining segmented
  // CJK words with spaces would change the shared index's compound bigrams.
  const normalized = query
    .normalize("NFC")
    .replaceAll(RETRIEVAL_TOKEN, (term) => {
      if (STOPWORDS.has(term.toLowerCase())) {
        return " ";
      }
      meaningful = true;
      return term;
    });
  return meaningful ? normalized.replaceAll(/\s+/gu, " ").trim() : query;
};

/**
 * The grounding preamble. The model is told to answer strictly from the injected
 * excerpts and to cite the pages it used as Markdown links (each excerpt is
 * headed by `## Title (/route)`), so citations render as real links in the panel.
 */
const BASE_INSTRUCTION =
  "You are a helpful documentation assistant for this project. Answer the user's question using ONLY the documentation excerpts below. Each excerpt is headed by its page as `## Page Title (/route)`. If the answer is not covered by the excerpts, say you don't know and suggest where in the docs to look — do not invent details. Always cite the pages you drew from, and write every citation as a Markdown link to that page using its route, e.g. [Page Title](/route).";

/** The most recent non-empty user message, used as the retrieval query. */
const lastUserMessage = (messages: AskMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && message.content?.trim()) {
      return message.content.trim();
    }
  }
  return "";
};

/** Locate a relevant window in already normalized content, retaining its offset. */
const excerptStart = (trimmed: string, query: string, max: number): number => {
  // Case-insensitive matching via regex rather than `indexOf` on a lowercased
  // copy: length-changing case mappings (Turkish İ → "i" + U+0307) would shift
  // every index in the copy, sliding the excerpt window off the match. Terms
  // come from TERM (letters, marks, digits and apostrophes), so no regex escaping.
  const positions: number[] = [];
  for (const term of queryTerms(query)) {
    // A standalone R must not match every r in prose. Unicode boundaries also
    // cover non-Latin letters and combining marks, unlike ASCII-oriented \b.
    // Connectors only block a boundary when joined to another word character,
    // so quoted standalone letters still match.
    const pattern =
      [...term].length === 1 && !UNSPACED_CHARACTER.test(term)
        ? `(?<![\\p{L}\\p{M}\\p{N}_]['’-]?)${term}(?!['’-]?[\\p{L}\\p{M}\\p{N}_])`
        : term;
    for (const match of trimmed.matchAll(new RegExp(pattern, "giu"))) {
      positions.push(match.index);
    }
  }
  // No query terms hit this doc — nothing to center on, so keep the head.
  if (positions.length === 0) {
    return 0;
  }

  // Pick the term hit whose following `max`-char window covers the most hits.
  // `positions` is non-empty here, so the first window (count ≥ 1) always wins
  // over the initial 0 and assigns a real offset to `best`.
  positions.sort((a, b) => a - b);
  let best = 0;
  let bestCount = 0;
  for (const start of positions) {
    const end = start + max;
    let count = 0;
    for (const pos of positions) {
      if (pos >= end) {
        break;
      }
      if (pos >= start) {
        count += 1;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      best = start;
    }
  }
  // Cap the lead-in at half the window: under a tight remaining budget `max`
  // can be smaller than EXCERPT_LEAD, and an uncapped `best - EXCERPT_LEAD`
  // start would end the slice before the very match it centered on.
  const lead = Math.min(EXCERPT_LEAD, Math.floor(max / 2));
  return Math.max(0, best - lead);
};

/**
 * Keep a query-relevant window alongside bounded introductory context. Long
 * pages often put prerequisites at the top and examples deep below the fold.
 * The cap includes omission markers and separators, but not the page heading.
 * Exported for testing; {@link createAskContext} is the runtime entry point.
 */
export const relevantExcerpt = (
  content: string,
  query: string,
  max: number
): string => {
  if (max <= 0) {
    return "";
  }
  // Match and slice the same NFC string so combining marks cannot shift offsets.
  const trimmed = content.normalize("NFC").trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  const head = (): string => `${trimmed.slice(0, max - 1).trimEnd()}…`;
  let start = excerptStart(trimmed, query, Math.max(0, max - 2));
  if (start === 0 || max < 3) {
    return head();
  }

  if (max >= MIN_EXCERPT_CHARS) {
    const introEnd = Math.floor(max / 2);
    const intro = trimmed.slice(0, introEnd).trimEnd();
    // Reserve the gap marker and a possible trailing ellipsis before selecting
    // the smaller relevant window. No prefix marker is needed after the gap.
    const size = max - intro.length - "\n…\n".length - 1;
    start = excerptStart(trimmed, query, size);
    if (start <= introEnd) {
      return head();
    }
    const end = start + size;
    return `${intro}\n…\n${trimmed.slice(start, end).trim()}${end < trimmed.length ? "…" : ""}`;
  }

  const end = start + max - 2;
  return `…${trimmed.slice(start, end).trim()}${end < trimmed.length ? "…" : ""}`;
};

/**
 * Build the request-time grounding function for the Ask AI endpoint.
 *
 * Lexical retrieval over Orama (the same index/ranking the search dialog and MCP
 * server use). The index is built once and memoized across requests. Returns a
 * grounded system prompt — the retrieved excerpts plus the page the user is
 * viewing — or `undefined` when there is nothing to ground on, so the endpoint
 * can fall back to its plain prompt.
 *
 * `options.instructions` (the `ai.ask.instructions` config) is appended after
 * the base instruction rather than replacing it: the base carries the
 * functional contract (answer only from the excerpts, cite pages as Markdown
 * links) that the panel's citation rendering depends on.
 *
 * `options.retrieval` (the `ai.ask.retrieval` config) sizes how much
 * documentation each question carries; omitted fields keep today's defaults.
 */
export const createAskContext = (
  data: AskData,
  options?: { instructions?: string; retrieval?: AskRetrievalOptions }
): ((
  messages: AskMessage[],
  page?: AskPage
) => Promise<string | undefined>) => {
  let dbPromise: Promise<Awaited<ReturnType<typeof buildOramaIndex>>> | null =
    null;
  const index = () => {
    dbPromise ??= buildOramaIndex(data.documents, data.defaultLocale);
    return dbPromise;
  };
  const byRoute = new Map(data.documents.map((doc) => [doc.route, doc]));
  const instruction = options?.instructions
    ? `${BASE_INSTRUCTION}\n\n${options.instructions}`
    : BASE_INSTRUCTION;
  const maxResults = options?.retrieval?.maxResults ?? MAX_RESULTS;
  const excerptChars = options?.retrieval?.excerptChars ?? EXCERPT_CHARS;
  const contextBudget = options?.retrieval?.contextBudget ?? CONTEXT_BUDGET;

  return async (messages, page) => {
    const list = Array.isArray(messages) ? messages : [];
    const query = lastUserMessage(list);
    if (!query) {
      return;
    }

    // The current page anchors retrieval to its locale and is injected first.
    const current = page?.path
      ? byRoute.get(normalizeRoute(page.path))
      : undefined;
    const db = await index();
    const hits = await queryOramaIndex(db, retrievalQuery(query), maxResults, {
      locale: current?.locale || undefined,
    });

    const seen = new Set<string>();
    const sections: string[] = [];
    let budget = contextBudget;
    const push = (doc: OramaDoc, label: string) => {
      if (seen.has(doc.route) || budget <= 0) {
        return;
      }
      // Skip a page that would be cut to a junk fragment: its excerpt is only
      // useful when it either fits whole or gets at least the minimum window.
      if (
        budget < MIN_EXCERPT_CHARS &&
        doc.content.normalize("NFC").trim().length > budget
      ) {
        return;
      }
      seen.add(doc.route);
      const body = relevantExcerpt(
        doc.content,
        query,
        Math.min(excerptChars, budget)
      );
      budget -= body.length;
      sections.push(`## ${doc.title} (${doc.route})${label}\n${body}`);
    };

    if (current) {
      push(current, " — the page the user is currently viewing");
    }
    for (const hit of hits) {
      push(hit, "");
    }

    if (sections.length === 0) {
      return;
    }
    return `${instruction}\n\n<docs>\n${sections.join("\n\n")}\n</docs>`;
  };
};
