/**
 * Tokenizer regressions.
 *
 * Each case pins a defect found in the archived runtime, so the new framework
 * cannot reintroduce it silently.
 */
import { assert, eq, hasAll } from './assert.ts'
import { identifiers, identifierKey, isIdentifier, matchExpression, tokenize } from '../src/tokenize.ts'

export function run(): void {
  // ── CJK: continuous text must be reachable by a short query ────────────────
  // Archived defect: `tokens()` matched `[\w\u4e00-\u9fff]+`, so a Chinese
  // sentence became ONE token and no sub-phrase could ever match it.
  hasAll(tokenize('用户喜欢简洁的输出'), ['用户', '户喜', '喜欢', '简洁'], 'CJK runs must emit overlapping bigrams')
  eq(tokenize('中'), ['中'], 'a lone CJK character is its own token')

  // ── Mixed CJK + Latin ─────────────────────────────────────────────────────
  // Archived defect: `用户偏好pytest框架` tokenized to one token, so a search
  // for `pytest` found nothing on the JSONL backend.
  hasAll(tokenize('用户偏好pytest框架'), ['pytest'], 'a Latin word inside a CJK sentence stays searchable')
  hasAll(tokenize('用户偏好pytest框架'), ['用户', '偏好', '框架'], 'the surrounding CJK is still bigrammed')

  // ── Non-ASCII, non-CJK scripts ────────────────────────────────────────────
  // Archived defect: the SQLite tokenizer's `[a-z0-9_]` class dropped every
  // other script, so `привет` became unsearchable after migrating backends.
  hasAll(tokenize('привет мир'), ['привет', 'мир'], 'Cyrillic words must be indexed, not dropped')
  hasAll(tokenize('café résumé'), ['café', 'résumé'], 'accented Latin keeps its accents')
  hasAll(tokenize('Ελληνικά κείμενο'), ['ελληνικά', 'κείμενο'], 'Greek must be indexed')
  hasAll(tokenize('abc中文def'), ['abc', 'def'], 'a Latin word adjacent to CJK is not swallowed')
  hasAll(tokenize('abc中文def'), ['中文'], 'and the CJK part of that mixed run is still bigrammed')

  // ── Identifier phrases get a folded key ───────────────────────────────────
  hasAll(tokenize('改了 memory_mvp.py'), ['memory_mvp_py'], 'an identifier phrase contributes a folded key')
  eq(identifierKey('memory_mvp.py'), 'memory_mvp_py', 'dots fold to underscores')
  eq(identifierKey('tests/test_storage.py'), 'tests_test_storage_py', 'slashes fold too')
  eq(identifierKey('bigfat-value-investing'), 'bigfat_value_investing', 'hyphens fold too')

  // ── Ordinary prose is not an identifier ───────────────────────────────────
  // Archived defect: the recovered downstream patch accepted any span, so
  // `how do I make the data load faster` produced eight "identifiers" and,
  // because those outranked BM25, noise beat relevance.
  eq(identifiers('please help with the deployment'), [], 'plain English produces no identifiers')
  eq(identifiers('how do I make the data load faster'), [], 'a prose question produces no identifiers')
  eq(identifiers('what is the best way to test this code'), [], 'prose about testing is still prose')
  eq(identifiers('这个项目的记忆框架怎么用'), [], 'CJK prose produces no identifiers')

  // ── Real identifiers survive ──────────────────────────────────────────────
  eq(identifiers('帮我查一下 memory_mvp.py 里 identifier_score 是怎么用的'), ['memory_mvp.py', 'identifier_score'], 'structured identifiers are kept')
  eq(identifiers('用户偏好pytest框架'), ['pytest'], 'a bare Latin word of four or more characters is kept')
  eq(identifiers('astra 项目的 bigfat-value-investing 分支状态'), ['astra', 'bigfat-value-investing'], 'hyphenated repository names are kept')
  eq(identifiers('检查 v0.6.1 的发布'), ['v0.6.1'], 'a version with dots is one identifier, not two')

  // ── isIdentifier boundaries ──────────────────────────────────────────────
  assert(isIdentifier('memory_sqlite.py'), 'dotted name is an identifier')
  assert(isIdentifier('src/core/engine.ts'), 'path is an identifier')
  assert(isIdentifier('index build step 2'), 'multi-word with a digit is an identifier')
  assert(!isIdentifier('the'), 'a stop word is not an identifier')
  assert(!isIdentifier('way'), 'a three-character word is left to the ordinary index')
  assert(!isIdentifier('the deployment'), 'a bare multi-word phrase is not an identifier')
  assert(!isIdentifier('v2'), 'a two-character token is not an identifier')

  // ── Query building ───────────────────────────────────────────────────────
  const expr = matchExpression('用户 偏好')
  assert(expr.includes('"用户"'), `match expression must contain the CJK bigram, got ${expr}`)
  eq(matchExpression('，。！？'), '', 'punctuation-only query yields no expression')
  assert(!matchExpression('abc').includes('""'), 'no empty term is emitted')

  console.log('  tokenize   ok')
}
