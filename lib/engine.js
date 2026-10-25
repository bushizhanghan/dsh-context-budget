// dsh-context-budget engine.
//
// The question this engine answers: of the context a model is handed on each
// turn, how much of it does the model not need to know?
//
// Established by reading real session logs on this machine, not by guessing:
//
//   1. A DSH session log (session.v4.jsonl.zstd) is UTF-16LE when the session
//      was started by the GUI and UTF-8 otherwise. Both shapes exist in the
//      same sessions tree, so the loader sniffs the BOM instead of assuming.
//   2. Per-turn injected context is spread over four event kinds:
//        - system/message          the assembled system prompt (identity,
//                                  team protocol, tool-usage rules, runtime
//                                  facts). Rebuilt every turn.
//        - user/message            injected instruction blocks, tagged by
//                                  data.source.kind: agent-instructions
//                                  (AGENTS.md), skill-catalog, runtime-context,
//                                  time-context, agent-teams, model-selection, …
//        - request/header          the tool schema array actually sent, with a
//                                  data.reason (initial / change / resume).
//        - request/context         provider/model/contextWindow, for the
//                                  denominator of the budget.
//   3. History (assistant/tool output) grows per turn; everything above is
//      either rebuilt or resent byte-identically. So the audit measures, per
//      turn: composition (how the budget splits), repetition (the same bytes
//      resent), and provenance (which surface owns each byte).
//
// Pure functions, no ctx, no I/O: every function here takes data it was handed.
// The session reader lives in engine.js too because it has no host
// dependencies beyond `zstd` on PATH, which is the same dependency the other
// audit plugins in this profile use.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// =====================================================================
// Session log reading
// =====================================================================

/**
 * Load a session.v4.jsonl.zstd into ordered events.
 *
 * Encoding is sniffed, not assumed: GUI-started sessions are UTF-16LE with a
 * BOM, CLI-started ones are plain UTF-8. Reading a UTF-16LE file as UTF-8
 * yields a file where every JSON line fails to parse — which is exactly the
 * bug this sniff prevents.
 */
export function loadSession(file) {
  if (!file || !existsSync(file)) return { events: [], error: `not found: ${file}` }
  let text
  try {
    const buf = execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 })
    text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le').slice(1) : buf.toString('utf8')
  } catch (e) {
    return { events: [], error: `cannot decompress (is zstd installed?): ${String(e.message).slice(0, 120)}` }
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {}
  }
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return { events, error: null }
}

// =====================================================================
// Token estimation
// =====================================================================

/**
 * Rough token count for a piece of text.
 *
 * Deliberately simple and monotone: 1 token ≈ 4 characters. It is an estimate,
 * so every report that uses it says "est" — the point of this plugin is the
 * *ratio* between surfaces and turns, and a constant divisor cancels out of a
 * ratio. The one real-world correction is CJK, where a single character is a
 * token on its own: counting CJK as 4 chars would understate Chinese-heavy
 * prompts (this machine's sessions are mostly Chinese) by ~4x.
 */
export function estimateTokens(text) {
  if (!text) return 0
  const s = String(text)
  let cjk = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x3000 && c <= 0x303f)) cjk += 1
  }
  return Math.max(1, Math.ceil((s.length - cjk) / 4 + cjk))
}

/** Token estimate for a measured character count of ASCII-ish text (JSON schemas, ASCII lines). */
export function tokensForChars(chars) {
  const n = Number(chars)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.ceil(n / 4)
}

// =====================================================================
// Classification: which surface owns a block of injected text
// =====================================================================

// Category constants. Order matters only for stable report output.
export const CATEGORIES = {
  SYSTEM: 'system',
  AGENTS: 'agents',
  SKILLS: 'skills',
  TOOLS: 'tools',
  RUNTIME: 'runtime',
  TEAM: 'team',
  HISTORY: 'history',
  OTHER: 'other',
}

/** user/message source.kind → category. Anything unlisted lands in OTHER. */
const USER_KIND_CATEGORY = {
  'agent-instructions': CATEGORIES.AGENTS,
  'skill-catalog': CATEGORIES.SKILLS,
  'runtime-context': CATEGORIES.RUNTIME,
  'time-context': CATEGORIES.RUNTIME,
  'agent-teams': CATEGORIES.TEAM,
  'agent-message': CATEGORIES.TEAM,
  'subagent-settled': CATEGORIES.TEAM,
  'model-selection': CATEGORIES.RUNTIME,
  user: CATEGORIES.HISTORY,
  goal: CATEGORIES.OTHER,
  'tool-jobs': CATEGORIES.OTHER,
  'dsh-rewind': CATEGORIES.OTHER,
  'user-approval': CATEGORIES.OTHER,
  'compact-checkpoint': CATEGORIES.HISTORY,
}

/** Which user/message kinds are re-injected standing instructions rather than turns of conversation. */
export function categoryOfUserKind(kind) {
  return USER_KIND_CATEGORY[kind] ?? CATEGORIES.OTHER
}

/** Total character length of a message event's content. */
export function contentChars(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content.length : 0
  let n = 0
  for (const p of content) {
    if (typeof p === 'string') n += p.length
    else if (p && typeof p === 'object' && typeof p.text === 'string') n += p.text.length
  }
  return n
}

/**
 * Joined text of a message event's content.
 *
 * Every part that carries `text` counts, including `reasoning` parts: they are
 * sent to the model, so they spend budget whether or not they are instructions.
 */
export function contentText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  const out = []
  for (const p of content) {
    if (typeof p === 'string') out.push(p)
    else if (p && typeof p === 'object' && typeof p.text === 'string') out.push(p.text)
  }
  return out.filter((s) => s !== '').join('\n')
}

// =====================================================================
// Per-turn budget model
// =====================================================================

/**
 * Build the per-turn budget model of a session.
 *
 * For each turn we record the bytes of every injected block, tagged with the
 * category that owns it, plus a stable signature (first 64 chars + length) so
 * two blocks can be compared for byte-identity without keeping the whole text
 * in memory across turns.
 *
 * Returns { turns, categories, requests, toolSets } where `turns` is ordered by
 * turn number.
 */
export function buildTurns(events) {
  const turnOf = (ev) => (ev && ev.data && typeof ev.data.turn === 'number' ? ev.data.turn : null)
  const byTurn = new Map()
  const ensure = (n) => {
    if (!byTurn.has(n)) byTurn.set(n, { turn: n, blocks: [], requests: 0, historyChars: 0, historyTokens: 0 })
    return byTurn.get(n)
  }
  const push = (turn, block) => {
    const t = ensure(turn)
    t.blocks.push(block)
  }

  // system/message carries the assembled system prompt, but only inside its
  // first turn is it new; the same text is resent every turn after. We record
  // it per turn with a signature so the repetition analysis can prove it.
  for (const ev of events) {
    const t = String(ev.type || '')
    const turn = turnOf(ev)
    if (t === 'system/message') {
      const text = contentText(ev.data?.message?.content)
      push(turn ?? 0, {
        category: CATEGORIES.SYSTEM,
        chars: text.length,
        tokens: estimateTokens(text),
        signature: signature(text),
        seq: ev.seq,
        label: 'system prompt',
      })
    } else if (t === 'user/message') {
      const d = ev.data || {}
      const text = contentText(d.content)
      const kind = d.source?.kind ?? 'user'
      const cat = categoryOfUserKind(kind)
      if (turn == null) {
        // pre-turn injection (the first user message of a session)
        push(0, block(kind, cat, text, ev.seq))
        continue
      }
      if (cat === CATEGORIES.HISTORY) {
        const t = ensure(turn)
        t.historyChars = (t.historyChars || 0) + text.length
        t.historyTokens = (t.historyTokens || 0) + estimateTokens(text)
        continue
      }
      push(turn, block(kind, cat, text, ev.seq))
    } else if (t === 'request/header') {
      const tools = ev.data?.header?.tools
      if (Array.isArray(tools)) {
        const t = ensure(turn ?? 0)
        t.requests += 1
        // Keep the last (largest) schema set sent this turn: a request that
        // changed its tools mid-turn is rare, and the newest set is the one
        // the model was actually shown.
        t.toolNames = tools.map((x) => x.name)
        t.toolChars = JSON.stringify(tools).length
        t.toolTokens = estimateTokens(JSON.stringify(tools))
        t.toolSignature = signature(tools.map((x) => `${x.name}:${JSON.stringify(x.parameters ?? {})}`).join('|'))
        t.reason = ev.data.reason ?? null
      }
    }
  }

  const turns = [...byTurn.values()].sort((a, b) => a.turn - b.turn)
  return turns
}

function block(kind, category, text, seq) {
  return {
    kind,
    category,
    chars: text.length,
    tokens: estimateTokens(text),
    signature: signature(text),
    seq,
    label: labelFor(kind, text),
  }
}

function labelFor(kind, text) {
  if (kind === 'agent-instructions') {
    const m = text.match(/Instructions from:\s*([^\n]+)/)
    return m ? `instructions · ${m[1].trim()}` : 'instructions'
  }
  if (kind === 'skill-catalog') return 'skill catalog'
  if (kind === 'runtime-context') return 'runtime context'
  if (kind === 'time-context') return 'time context'
  if (kind === 'model-selection') return 'model change notice'
  if (kind === 'agent-teams' || kind === 'agent-message') return `team · ${kind}`
  return kind
}

/** Stable short identity of a text: length + head + tail. Cheap and collision-safe enough for repetition detection. */
export function signature(text) {
  const s = String(text ?? '')
  if (s.length === 0) return 'empty'
  return `${s.length}:${s.slice(0, 32)}|${s.slice(-32)}`
}

/**
 * Aggregate a turn list into a composition table.
 *
 * Returns { categories: { <cat>: {tokens, blocks} }, totalTokens, perTurn }.
 */
export function composition(turns) {
  const categories = {}
  let total = 0
  const perTurn = []
  const bump = (cat, tokens) => {
    categories[cat] = categories[cat] || { tokens: 0, blocks: 0 }
    categories[cat].tokens += tokens
    categories[cat].blocks += 1
  }
  for (const t of turns) {
    const row = { turn: t.turn, categories: {}, total: 0 }
    for (const b of t.blocks) {
      row.categories[b.category] = (row.categories[b.category] || 0) + b.tokens
      bump(b.category, b.tokens)
    }
    if (t.toolTokens) {
      row.categories[CATEGORIES.TOOLS] = (row.categories[CATEGORIES.TOOLS] || 0) + t.toolTokens
      bump(CATEGORIES.TOOLS, t.toolTokens)
    }
    if (t.historyTokens) {
      row.categories[CATEGORIES.HISTORY] = (row.categories[CATEGORIES.HISTORY] || 0) + t.historyTokens
      bump(CATEGORIES.HISTORY, t.historyTokens)
    }
    row.total = Object.values(row.categories).reduce((a, b) => a + b, 0)
    total += row.total
    perTurn.push(row)
  }
  return { categories, totalTokens: total, perTurn }
}

// =====================================================================
// Repetition: the pure-waste detector
// =====================================================================

/**
 * Find injected content that is resent byte-identically.
 *
 * A block that appears in turn N and again in turn N+k with the same signature
 * costs the same tokens again and teaches the model nothing new: that is the
 * pure waste this plugin exists to quantify. The first occurrence is not waste
 * (the model has to see it once); every later occurrence is.
 *
 * Returns { repeated: [{category,label,occurrences,tokensEach,wasteTokens,firstTurn,lastTurn}], wasteTokens, totalTokens }.
 */
export function detectRepetition(turns) {
  const seen = new Map()
  const order = []
  for (const t of turns) {
    for (const b of t.blocks) {
      const key = `${b.category}\u0000${b.signature}`
      if (!seen.has(key)) {
        seen.set(key, { category: b.category, label: b.label, tokensEach: b.tokens, turns: [] })
        order.push(key)
      }
      const rec = seen.get(key)
      rec.turns.push(t.turn)
    }
  }
  const repeated = []
  let waste = 0
  let total = 0
  for (const key of order) {
    const rec = seen.get(key)
    total += rec.tokensEach * rec.turns.length
    if (rec.turns.length > 1) {
      const wasteTokens = rec.tokensEach * (rec.turns.length - 1)
      waste += wasteTokens
      repeated.push({
        category: rec.category,
        label: rec.label,
        occurrences: rec.turns.length,
        tokensEach: rec.tokensEach,
        wasteTokens,
        firstTurn: rec.turns[0],
        lastTurn: rec.turns[rec.turns.length - 1],
      })
    }
  }
  repeated.sort((a, b) => b.wasteTokens - a.wasteTokens)
  return { repeated, wasteTokens: waste, totalTokens: total }
}

/**
 * Per-turn waste: how much of a turn's injected context is a repeat of
 * something the model has already been sent.
 *
 * This is the number that matters for "why is this turn expensive": history is
 * legitimately cumulative, but a system prompt, a skill catalog and a tool set
 * resent unchanged are the same bytes paying rent again.
 */
export function perTurnWaste(turns) {
  const seen = new Set()
  const out = []
  for (const t of turns) {
    let repeatTokens = 0
    let freshTokens = 0
    for (const b of t.blocks) {
      const key = `${b.category}\u0000${b.signature}`
      if (seen.has(key)) repeatTokens += b.tokens
      else {
        freshTokens += b.tokens
        seen.add(key)
      }
    }
    out.push({ turn: t.turn, repeatTokens, freshTokens, requests: t.requests })
  }
  return out
}

// =====================================================================
// Skill catalog
// =====================================================================

/** One skill line in a skill-catalog block: `- \`name\`: description`. */
export function parseSkillCatalog(text) {
  if (!text) return []
  const out = []
  for (const line of String(text).split('\n')) {
    const m = line.match(/^- `([^`]+)`:\s*(.*)$/)
    if (!m) continue
    out.push({ name: m[1], description: m[2], chars: line.length })
  }
  return out
}

/**
 * Skill-catalog governance.
 *
 * The catalog is injected as one block per turn, so every installed skill's
 * description is paid for on every turn whether or not it is ever used. This
 * measures that standing cost and ranks skills by description length, because
 * length is the only signal available without an LLM: a 500-character
 * description for a skill that is invoked once a month is a bad trade.
 *
 * `usage` maps skill name → number of `skill` tool calls observed in the
 * session, so the report can separate "big and used" from "big and dead".
 */
/**
 * Rank skills by the tokens their description costs on every turn.
 *
 * `skills` entries carry either `chars` (a measured line length, as produced by
 * parseSkillCatalog) or just `description` (as supplied by a caller that has
 * the catalog but not the line), so the cost is computed from whichever is
 * present. `usage` maps skill name → number of `skill` tool calls observed, so
 * the report can separate "big and used" from "big and dead".
 */
export function rankSkills(skills, usage = {}) {
  return skills
    .map((s) => {
      const chars = typeof s.chars === 'number' ? s.chars : String(s.description ?? '').length
      return {
        name: s.name,
        chars,
        tokensPerTurn: tokensForChars(chars),
        uses: Number(usage[s.name] || 0),
      }
    })
    .sort((a, b) => b.tokensPerTurn - a.tokensPerTurn)
}

/**
 * Which skills should be lazy-loaded.
 *
 * Rule: a skill whose description costs at least `minTokens` (default 60) on
 * every turn and was never invoked in this session is a lazy-load candidate.
 * That is deliberately conservative — it never flags a skill the session leaned
 * on, and it ignores skills with no usage signal at all rather than guessing
 * that an unused-looking skill is dead (it may be used in another session).
 */
export function lazyLoadCandidates(ranked, { minTokens = 60 } = {}) {
  return ranked.filter((s) => s.uses === 0 && s.tokensPerTurn >= minTokens)
}

// =====================================================================
// Tool schema inflation
// =====================================================================

/**
 * Attribute tool-schema bytes to a plugin group.
 *
 * Tool names carry their owner: `mcp__<server>__<tool>` is an MCP server,
 * `agent_teams_*` / `team_task_*` are the AgentTeams plugin, `dsh_ppt_*` is the
 * ppt plugin, and everything else is a built-in. The grouping is a prefix rule,
 * not a registry lookup, so it works on any machine without a plugin list.
 */
export function toolGroup(name) {
  const n = String(name || '')
  if (n.startsWith('mcp__')) {
    const parts = n.split('__')
    return `mcp:${parts[1] || 'unknown'}`
  }
  if (n.startsWith('agent_teams_') || n.startsWith('team_task_')) return 'plugin:agent-teams'
  if (n.startsWith('dsh_ppt_')) return 'plugin:ppt-fusion'
  if (n.startsWith('ctx_budget')) return 'plugin:context-budget'
  const twoWords = n.split('_').slice(0, 2).join('_')
  if (twoWords && twoWords !== n) return `tool:${twoWords}`
  return `tool:${n || 'unknown'}`
}

/** Rank tool groups by the tokens their schemas cost per turn. */
export function toolInflation(tools) {
  const groups = new Map()
  let total = 0
  for (const t of tools || []) {
    const chars = JSON.stringify(t).length
    const g = toolGroup(t.name)
    if (!groups.has(g)) groups.set(g, { group: g, tools: 0, chars: 0 })
    const rec = groups.get(g)
    rec.tools += 1
    rec.chars += chars
    total += chars
  }
  const rows = [...groups.values()].map((r) => ({ ...r, tokensPerTurn: tokensForChars(r.chars) }))
  rows.sort((a, b) => b.tokensPerTurn - a.tokensPerTurn)
  return { rows, totalChars: total, totalTokens: tokensForChars(total) }
}

// =====================================================================
// Whole-session audit
// =====================================================================

/**
 * Audit one session's context budget.
 *
 * Returns { ok, session, turns, composition, repetition, perTurn, skills,
 * tools, report }.
 */
export function auditSession(events, { usage = {}, skills = [], tools = [] } = {}) {
  const turns = buildTurns(events)
  const comp = composition(turns)
  const rep = detectRepetition(turns)
  const perTurn = perTurnWaste(turns)
  const inflated = toolInflation(tools)
  const ranked = rankSkills(skills, usage)
  const lazy = lazyLoadCandidates(ranked)

  const turnCount = turns.length
  const requests = turns.reduce((a, t) => a + t.requests, 0)
  const wasteRatio = comp.totalTokens > 0 ? rep.wasteTokens / comp.totalTokens : 0
  // The model actually used comes from the request the host sent, which is the
  // authoritative record; model/selection is only the last UI change.
  const model =
    events.find((e) => e.type === 'request/header')?.data?.header?.config?.model ??
    events.find((e) => e.type === 'model/selection')?.data?.model ??
    null
  const contextWindow = events.find((e) => e.type === 'request/context')?.data?.contextWindow ?? null

  return {
    ok: true,
    session: {
      events: events.length,
      turns: turnCount,
      requests,
      model,
      contextWindow,
      cwd: events.find((e) => e.type === 'session')?.data?.cwd ?? null,
    },
    turns,
    composition: comp,
    repetition: rep,
    perTurn,
    skills: { ranked, lazy, total: skills.length, tokensPerTurn: ranked.reduce((a, s) => a + s.tokensPerTurn, 0) },
    tools: inflated,
    wasteRatio,
  }
}

/** Render the human-readable report used as the tool's text output. */
export function renderReport(result, { title }) {
  const L = []
  const head = title ? `${title}: ` : ''
  L.push('')
  L.push(`${head}${result.session.turns} turns, ${result.session.requests} request(s)`)
  L.push(`  injected context total (est): ${result.composition.totalTokens} tok`)
  L.push(`  repeated unchanged content: ${result.repetition.wasteTokens} tok (${(result.wasteRatio * 100).toFixed(1)}% of injected)`)
  L.push('')
  L.push('composition (est tokens, summed over turns)')
  const cats = Object.entries(result.composition.categories).sort((a, b) => b[1].tokens - a[1].tokens)
  for (const [cat, v] of cats) {
    L.push(`  ${cat.padEnd(10)} ${String(v.tokens).padStart(8)}  (${v.blocks} block(s))`)
  }
  if (result.repetition.repeated.length) {
    L.push('')
    L.push('repeated unchanged content (waste)')
    for (const r of result.repetition.repeated.slice(0, 8)) {
      L.push(`  ${r.label}  ${r.occurrences}x  ${r.tokensEach} tok each  = ${r.wasteTokens} tok waste`)
    }
  }
  if (result.tools.rows.length) {
    L.push('')
    L.push('tool schema inflation (est tokens per turn)')
    for (const r of result.tools.rows.slice(0, 8)) {
      L.push(`  ${r.group.padEnd(24)} ${String(r.tokensPerTurn).padStart(7)}  (${r.tools} tool(s))`)
    }
  }
  if (result.skills.ranked.length) {
    L.push('')
    L.push(`skill catalog: ${result.skills.total} skills, ${result.skills.tokensPerTurn} est tok per turn`)
    for (const s of result.skills.ranked.slice(0, 6)) {
      L.push(`  ${s.name.padEnd(30)} ${String(s.tokensPerTurn).padStart(5)} tok  used ${s.uses}x`)
    }
    if (result.skills.lazy.length) {
      L.push(`  lazy-load candidates: ${result.skills.lazy.slice(0, 10).map((s) => s.name).join(', ')}`)
    }
  }
  L.push('')
  return L.join('\n')
}