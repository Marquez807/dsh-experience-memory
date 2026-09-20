/**
 * The framework's only text → token conversion.
 *
 * Every index build, every query and every identifier comparison goes through
 * here. A second tokenizer is how the previous system ended up with one backend
 * that could search Cyrillic and another that could not, and with a `pack`
 * ordering that was decided by random uuid strings.
 *
 * Erasable-syntax TypeScript only: this file is executed directly by Node's
 * type stripping, so `enum`, `namespace` and parameter properties are banned.
 */

/** CJK ideographs: Ext-A, Unified and the compatibility block. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
/**
 * Word runs in ANY script — `\p{L}\p{N}_`, not `[a-z0-9_]`. Restricting this to
 * ASCII is exactly how the archived SQLite tokenizer dropped Cyrillic, Greek
 * and accented Latin, making those records unreachable after a backend switch.
 * CJK is removed before this pass so it is bigrammed rather than kept whole.
 */
const WORD_RUN = /[\p{L}\p{N}_]+/gu
/** Characters that mark a span as an identifier rather than prose. */
const STRUCTURAL = /[._/:-]/
/**
 * Candidate spans: a Latin word plus any adjacent identifier punctuation, so
 * `tests/test_storage.py` and `bigfat-value-investing` survive as one span.
 */
const PHRASE_SPAN = /[a-z][a-z0-9_./:-]*(?:[ \t]+[a-z][a-z0-9_./:-]*)*/g

/** Term ceiling per record or query, so one verbose record cannot flood the index. */
export const MAX_TOKENS = 256

/**
 * Ordinary English words that must never be read as identifiers. Deliberately
 * short: the structural rule does the real work, and a long stop list would
 * start rejecting legitimate short names.
 */
const STOP                      = new Set([
  'the', 'and', 'this', 'that', 'please', 'help', 'with', 'from', 'only', 'what', 'how',
])

/** Overlapping bigrams of a CJK run; a single character stays itself. */
export function cjkBigrams(run        )           {
  if (run.length === 1) return [run]
  const out           = []
  for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  return out
}

/**
 * Whether a span is an explicit identifier rather than ordinary prose.
 *
 * A multi-word span counts only when it carries a structural signal, because
 * every English sentence otherwise expands into "identifiers" and, since
 * identifier hits outrank BM25, ordinary prose would outrank real relevance.
 * A bare word counts from four characters; two- and three-character words are
 * left to the ordinary index, which already resolves them.
 */
export function isIdentifier(span        )          {
  const value = span.trim()
  if (value.length < 3 || STOP.has(value)) return false
  if (STRUCTURAL.test(value)) return true
  if (/[0-9]/.test(value)) return true
  return !value.includes(' ') && value.length >= 4
}

/**
 * Single-token key for an identifier phrase: separators and spaces fold to `_`,
 * so `memory_mvp.py`, `memory-mvp.py` and `memory mvp py` all collapse to the
 * same key and an exact-match lookup needs no phrase parsing.
 */
export function identifierKey(phrase        )         {
  return phrase
    .trim()
    .toLowerCase()
    .replace(/[./:\-\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Identifier phrases in a query or a record, widest first and then adjacent
 * pairs, so `index build step 2` is reachable by the full phrase and by
 * `index build`.
 */
export function identifiers(text        , limit = 64)           {
  const found           = []
  for (const span of text.toLowerCase().match(PHRASE_SPAN) ?? []) {
    const value = span.replace(/\s+/g, ' ').trim()
    if (value.length < 3 || value.length > 100) continue
    const words = value.split(' ')
    if (words.length > 8) continue
    const options = [value, ...words.slice(0, -1).map((_, i) => words.slice(i, i + 2).join(' '))]
    for (const option of options) {
      if (isIdentifier(option) && !found.includes(option)) found.push(option)
      if (found.length >= limit) return found
    }
  }
  return found
}

/**
 * Every term this text contributes to the index: CJK bigrams, Latin words, and
 * one folded key per identifier phrase. Deduplicated, order-stable, bounded.
 */
export function tokenize(text        )           {
  const lower = text.toLowerCase()
  const out           = []
  const seen = new Set        ()
  const push = (term        )       => {
    if (term !== '' && !seen.has(term)) {
      seen.add(term)
      out.push(term)
    }
  }

  for (const run of lower.match(CJK_RUN) ?? []) for (const bigram of cjkBigrams(run)) push(bigram)
  // CJK is stripped before the word pass: `\p{L}` also matches ideographs, and a
  // mixed run like `abc中文def` must yield `abc` and `def`, not one joined token.
  const withoutCjk = lower.replace(CJK_RUN, ' ')
  for (const word of withoutCjk.match(WORD_RUN) ?? []) push(word)
  for (const phrase of identifiers(lower)) push(identifierKey(phrase))

  return out.slice(0, MAX_TOKENS)
}

/**
 * FTS5 MATCH expression for a query. Terms already come from {@link tokenize},
 * which cannot emit quotes, but they are escaped anyway so a future caller that
 * bypasses the tokenizer cannot inject query syntax.
 */
export function matchExpression(query        )         {
  const terms = tokenize(query)
  if (terms.length === 0) return ''
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * The query's ordinary terms — CJK bigrams and plain words — with identifier keys
 * removed, so a caller can ask how much *lexical* text a record shares with a query.
 *
 * This split exists because an identifier hit and a shared bigram are not the same
 * kind of evidence. `batchSize` overlapping means the two texts are about the same
 * thing; a single shared `这个` means only that both contain a two-character function
 * word. Callers that need precision use the second list to demand more than one hit.
 *
 * `includes` on a lowercased record is a valid test for these terms — they are raw
 * substrings of the text — but it is NOT valid for identifier keys, which are folded
 * (`memory_mvp_py` for `memory_mvp.py`), which is the other reason they are excluded.
 */
export function lexicalQueryTerms(query        )           {
  const identifierTerms = new Set(identifiers(query).map(identifierKey))
  return tokenize(query).filter(term => !identifierTerms.has(term))
}
