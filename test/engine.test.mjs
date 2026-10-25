// Unit tests: one per rule the engine depends on.
//
// Every fixture here is a real event shape copied from session logs on this
// machine (session.v4.jsonl.zstd under ~/.dsh/sessions), reduced to the fields
// the engine reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CATEGORIES,
  auditSession,
  buildTurns,
  categoryOfUserKind,
  composition,
  contentText,
  detectRepetition,
  estimateTokens,
  lazyLoadCandidates,
  parseSkillCatalog,
  perTurnWaste,
  rankSkills,
  signature,
  toolGroup,
  toolInflation,
} from '../lib/engine.js'

// ---------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------

test('estimateTokens counts CJK as one token per character', () => {
  // A Chinese sentence under 1 token/char/char would be understated ~4x, and
  // this machine's sessions are mostly Chinese.
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('a'.repeat(400)), 100)
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
})

// ---------------------------------------------------------------------
// Category mapping
// ---------------------------------------------------------------------

test('every injected user kind maps to a real category', () => {
  assert.equal(categoryOfUserKind('agent-instructions'), CATEGORIES.AGENTS)
  assert.equal(categoryOfUserKind('skill-catalog'), CATEGORIES.SKILLS)
  assert.equal(categoryOfUserKind('runtime-context'), CATEGORIES.RUNTIME)
  assert.equal(categoryOfUserKind('time-context'), CATEGORIES.RUNTIME)
  assert.equal(categoryOfUserKind('agent-teams'), CATEGORIES.TEAM)
  assert.equal(categoryOfUserKind('agent-message'), CATEGORIES.TEAM)
  assert.equal(categoryOfUserKind('subagent-settled'), CATEGORIES.TEAM)
  assert.equal(categoryOfUserKind('user'), CATEGORIES.HISTORY)
  assert.equal(categoryOfUserKind('compact-checkpoint'), CATEGORIES.HISTORY)
})

test('an unknown user kind is not silently dropped', () => {
  // A new injection surface appearing in a future DSH must show up as OTHER
  // rather than vanish from the audit.
  assert.equal(categoryOfUserKind('brand-new-surface'), CATEGORIES.OTHER)
})

// ---------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------

test('contentText joins text parts and ignores non-text parts', () => {
  const content = [
    { type: 'text', text: 'one' },
    { type: 'reasoning', text: 'private' },
    { type: 'text', text: 'two' },
  ]
  // Reasoning text is NOT injected context the model was asked to read as
  // instruction, but it IS sent to the model, so the budget counts it.
  assert.equal(contentText(content), 'one\nprivate\ntwo')
  // a text part with no `text` field contributes nothing, not "undefined"
  assert.equal(contentText([{ type: 'text' }, 'plain']), 'plain')
  assert.equal(contentText('plain'), 'plain')
  assert.equal(contentText(null), '')
})

// ---------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------

test('signature is stable and distinguishes different text of the same length', () => {
  assert.equal(signature('hello world'), signature('hello world'))
  assert.notEqual(signature('aaaaaaaaaa'), signature('bbbbbbbbbb'))
  assert.equal(signature(''), 'empty')
})

// ---------------------------------------------------------------------
// Turn model
// ---------------------------------------------------------------------

const sysEvent = (turn, text) => ({ type: 'system/message', seq: 1, data: { turn, message: { role: 'system', content: [{ type: 'text', text }] } } })
const userEvent = (kind, text, turn = 2) => ({ type: 'user/message', seq: 2, data: { turn, content: [{ type: 'text', text }], source: { kind } } })
const headerEvent = (tools, reason = 'initial') => ({ type: 'request/header', seq: 3, data: { turn: 2, reason, header: { tools } } })

test('buildTurns attributes each injected block to its turn and category', () => {
  const turns = buildTurns([
    sysEvent(1, 'SYSTEM PROMPT'),
    userEvent('agent-instructions', 'Instructions from: ~/.dsh/AGENTS.md\n\n# rules', 1),
    userEvent('skill-catalog', '<system-reminder>\n- `a`: does a\n</system-reminder>', 1),
    userEvent('runtime-context', 'Current runtime context.', 1),
    userEvent('user', 'real user text', 2),
    headerEvent([{ name: 'read', description: 'read a file', parameters: { type: 'object' } }]),
  ])
  assert.equal(turns.length, 2)
  const t1 = turns[0]
  const cats = t1.blocks.map((b) => b.category)
  assert.deepEqual(cats.sort(), [CATEGORIES.AGENTS, CATEGORIES.RUNTIME, CATEGORIES.SKILLS, CATEGORIES.SYSTEM].sort())
  // the request/header belongs to turn 2, where the LLM call actually happened
  const t2 = turns[1]
  assert.equal(t1.requests, 0)
  assert.equal(t2.requests, 1)
  assert.equal(t2.toolTokens > 0, true)
  // the tool signature identifies the schema set that was actually sent
  assert.equal(t2.toolSignature, signature('read:{"type":"object"}'))
  assert.equal(t2.reason, 'initial')
  assert.deepEqual(t2.toolNames, ['read'])
  // the real user message is history, not an injected block
  assert.equal(t2.blocks.length, 0)
  assert.equal(t2.historyTokens > 0, true)
})

test('composition sums categories over turns', () => {
  const turns = buildTurns([sysEvent(1, 'x'.repeat(400)), sysEvent(2, 'x'.repeat(400))])
  const comp = composition(turns)
  assert.equal(comp.categories[CATEGORIES.SYSTEM].tokens, 200)
  assert.equal(comp.totalTokens, 200)
  assert.equal(comp.perTurn.length, 2)
})

// ---------------------------------------------------------------------
// Repetition — the pure-waste rule
// ---------------------------------------------------------------------

test('the first occurrence is not waste; every identical re-send is', () => {
  const turns = buildTurns([
    sysEvent(1, 'SAME SYSTEM PROMPT'),
    sysEvent(2, 'SAME SYSTEM PROMPT'),
    sysEvent(3, 'SAME SYSTEM PROMPT'),
  ])
  const rep = detectRepetition(turns)
  assert.equal(rep.repeated.length, 1)
  const r = rep.repeated[0]
  assert.equal(r.category, CATEGORIES.SYSTEM)
  assert.equal(r.occurrences, 3)
  assert.equal(r.wasteTokens, r.tokensEach * 2)
  assert.equal(rep.wasteTokens, r.wasteTokens)
})

test('changed content is not counted as repetition', () => {
  const turns = buildTurns([sysEvent(1, 'VERSION ONE'), sysEvent(2, 'VERSION TWO')])
  assert.equal(detectRepetition(turns).wasteTokens, 0)
  assert.equal(detectRepetition(turns).repeated.length, 0)
})

test('perTurnWaste splits fresh from repeated tokens per turn', () => {
  const turns = buildTurns([sysEvent(1, 'A'.repeat(400)), sysEvent(2, 'A'.repeat(400)), sysEvent(2, 'B'.repeat(400))])
  const rows = perTurnWaste(turns)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].repeatTokens, 0)
  assert.equal(rows[0].freshTokens, 100)
  // turn 2 resends the 100-token system prompt and adds 100 fresh tokens
  assert.equal(rows[1].repeatTokens, 100)
  assert.equal(rows[1].freshTokens, 100)
})

// ---------------------------------------------------------------------
// Skill catalog
// ---------------------------------------------------------------------

test('parseSkillCatalog reads the - `name`: description lines', () => {
  const text = [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions.',
    '',
    '<available_skills>',
    '- `alpha`: first skill description',
    '- `beta`: second skill description',
    '</available_skills>',
    '</system-reminder>',
  ].join('\n')
  const skills = parseSkillCatalog(text)
  assert.equal(skills.length, 2)
  assert.equal(skills[0].name, 'alpha')
  assert.equal(skills[0].description, 'first skill description')
  assert.equal(parseSkillCatalog('').length, 0)
})

test('rankSkills sorts by per-turn cost and carries usage', () => {
  // tokensPerTurn is ceil(chars/4): 400→100, 200→50, 40→10
  const ranked = rankSkills(
    [
      { name: 'small', description: 'x', chars: 40 },
      { name: 'big', description: 'y', chars: 400 },
      { name: 'used', description: 'z', chars: 200 },
    ],
    { used: 3 },
  )
  assert.deepEqual(ranked.map((r) => r.name), ['big', 'used', 'small'])
  assert.deepEqual(ranked.map((r) => r.tokensPerTurn), [100, 50, 10])
  assert.equal(ranked[1].uses, 3)
})

test('lazyLoadCandidates never flags a skill that was used', () => {
  const ranked = rankSkills([{ name: 'big-unused', description: 'y', chars: 400 }, { name: 'big-used', description: 'z', chars: 400 }], { 'big-used': 1 })
  const lazy = lazyLoadCandidates(ranked)
  assert.equal(lazy.length, 1)
  assert.equal(lazy[0].name, 'big-unused')
  // a skill used even once is not a lazy-load candidate
  assert.equal(lazyLoadCandidates(rankSkills([{ name: 'big-used', description: 'z', chars: 400 }], { 'big-used': 1 })).length, 0)
})

test('lazyLoadCandidates ignores cheap skills even when unused', () => {
  // A 20-token description is not worth the governance churn.
  const lazy = lazyLoadCandidates(rankSkills([{ name: 'tiny', description: 'x', chars: 20 }]))
  assert.equal(lazy.length, 0)
})

// ---------------------------------------------------------------------
// Tool inflation
// ---------------------------------------------------------------------

test('toolGroup attributes mcp tools to their server', () => {
  assert.equal(toolGroup('mcp__wincu__windows_computer_use_click'), 'mcp:wincu')
  assert.equal(toolGroup('agent_teams_claim_task'), 'plugin:agent-teams')
  assert.equal(toolGroup('team_task_update'), 'plugin:agent-teams')
  assert.equal(toolGroup('dsh_ppt_review'), 'plugin:ppt-fusion')
  assert.equal(toolGroup('ctx_budget'), 'plugin:context-budget')
  assert.equal(toolGroup('read'), 'tool:read')
})

test('toolInflation ranks groups by tokens per turn', () => {
  const tools = [
    { name: 'read', description: 'r', parameters: { type: 'object' } },
    { name: 'mcp__wincu__windows_computer_use_click', description: 'c'.repeat(2000), parameters: { type: 'object' } },
    { name: 'mcp__wincu__windows_computer_use_type_text', description: 't'.repeat(2000), parameters: { type: 'object' } },
  ]
  const inf = toolInflation(tools)
  assert.equal(inf.rows[0].group, 'mcp:wincu')
  assert.equal(inf.rows[0].tools, 2)
  // 4000 description chars ≈ 1000 tokens, plus the schema wrapper
  assert.equal(inf.rows[0].tokensPerTurn > 900, true)
  assert.equal(inf.totalTokens > 0, true)
})

// ---------------------------------------------------------------------
// Whole-session audit
// ---------------------------------------------------------------------

test('auditSession reports a composition and a waste ratio', () => {
  const events = [
    { type: 'session', data: { cwd: 'E:\\dsh' } },
    { type: 'model/selection', data: { model: 'deepseek-v4-flash' } },
    sysEvent(1, 'S'.repeat(4000)),
    userEvent('skill-catalog', '<system-reminder>\n- `a`: x'.padEnd(400, 'x') + '\n</system-reminder>', 1),
    headerEvent([{ name: 'read', description: 'r', parameters: { type: 'object' } }]),
    sysEvent(2, 'S'.repeat(4000)),
    userEvent('skill-catalog', '<system-reminder>\n- `a`: x'.padEnd(400, 'x') + '\n</system-reminder>', 2),
    headerEvent([{ name: 'read', description: 'r', parameters: { type: 'object' } }]),
  ]
  const skills = [{ name: 'a', description: 'x', chars: 40 }]
  const tools = [{ name: 'read', description: 'r', parameters: { type: 'object' } }]
  const result = auditSession(events, { skills, tools, usage: { a: 1 } })
  assert.equal(result.ok, true)
  assert.equal(result.session.turns, 2)
  assert.equal(result.session.model, 'deepseek-v4-flash')
  assert.equal(result.session.cwd, 'E:\\dsh')
  assert.equal(result.composition.categories[CATEGORIES.SYSTEM].tokens, 2000)
  assert.equal(result.repetition.wasteTokens > 0, true)
  assert.equal(result.wasteRatio > 0 && result.wasteRatio < 1, true)
  assert.equal(result.skills.ranked[0].uses, 1)
  assert.equal(result.tools.rows[0].group, 'tool:read')
})

test('auditSession prefers the model the request actually used', () => {
  // model/selection is the last UI change; request/header.config.model is what
  // the host sent. When both exist and disagree, the request wins.
  const events = [
    { type: 'model/selection', data: { model: 'ui-model' } },
    { type: 'request/header', data: { turn: 1, reason: 'initial', header: { config: { model: 'sent-model' }, tools: [] } } },
    { type: 'request/context', data: { contextWindow: 128000 } },
    sysEvent(1, 'x'),
  ]
  const r = auditSession(events)
  assert.equal(r.session.model, 'sent-model')
  assert.equal(r.session.contextWindow, 128000)
})

test('auditSession on an empty session is honest rather than dividing by zero', () => {
  const result = auditSession([])
  assert.equal(result.ok, true)
  assert.equal(result.session.turns, 0)
  assert.equal(result.wasteRatio, 0)
  assert.equal(result.composition.totalTokens, 0)
})
