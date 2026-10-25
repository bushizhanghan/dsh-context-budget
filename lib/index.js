// dsh-context-budget: agent tools over the per-turn context budget model.
//
// Four tools, one per question an operator actually asks:
//
//   ctx_budget        what is this turn's context made of, and how much of it
//                     is the same bytes as last turn?
//   ctx_budget_sweep  every session, ranked by waste.
//   ctx_budget_skills the standing cost of the skill catalog, and which
//                     skills should be lazy-loaded.
//   ctx_budget_tools  which plugin's tool schemas cost the most per turn.
//
// Deterministic throughout: no LLM is called, so every number here can be
// recomputed by hand from the session log.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import {
  auditSession,
  buildTurns,
  loadSession,
  parseSkillCatalog,
  renderReport,
  toolInflation,
  tokensForChars,
} from './engine.js'

export const name = 'context-budget'
export const inject = ['tools']

const Config = {
  // Where DSH keeps session logs.
  sessionsDir: '',
  // Cap the number of sessions a sweep will read, so a large history cannot
  // hang the tool. Override with a bigger number when you want the full sweep.
  maxSessions: 30,
}

/** Resolve the sessions dir: explicit arg, config, or the default per-profile layout. */
function resolveSessionsDir(dir) {
  if (dir) return dir
  if (Config.sessionsDir) return Config.sessionsDir
  return join(homedir(), '.dsh', 'sessions')
}

/**
 * Every session log under a sessions root.
 *
 * The layout is `<sessions>/<workspace-slug>/session-<uuid>/session.v4.jsonl.zstd`
 * — a workspace level sits between the root and the session dirs, so a flat
 * scan of the root finds nothing. Walk down to the session dirs and keep the
 * workspace slug with each row.
 */
function listSessions(root, limit) {
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir, workspace, depth) => {
    if (depth > 2 || out.length > (typeof limit === 'number' ? limit : 500)) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      const log = join(full, 'session.v4.jsonl.zstd')
      if (existsSync(log)) {
        out.push({ name: e.name, workspace, file: log })
        continue
      }
      walk(full, e.name, depth + 1)
    }
  }
  walk(root, '(root)', 0)
  return typeof limit === 'number' ? out.slice(0, limit) : out
}

/** Accept a session path, a session dir, or a bare session id. */
function resolveSessionFile(arg) {
  if (!arg) return null
  if (existsSync(arg) && arg.endsWith('.zstd')) return arg
  const direct = join(arg, 'session.v4.jsonl.zstd')
  if (existsSync(direct)) return direct
  const byId = listSessions(resolveSessionsDir('')).find((s) => s.name === arg || s.name === `session-${arg}`)
  return byId ? byId.file : null
}

/**
 * The extra inputs the pure engine cannot see in the turn model: the raw skill
 * catalog text and the tool schema array actually sent. Both come from the same
 * events the engine already read, so no second pass over the file is needed.
 */
function extractInputs(events) {
  let skills = []
  let tools = []
  let catalogSeen = null
  for (const ev of events) {
    if (ev.type === 'user/message' && ev.data?.source?.kind === 'skill-catalog' && catalogSeen === null) {
      catalogSeen = ev.data.content.map((c) => c.text || '').join('\n')
      skills = parseSkillCatalog(catalogSeen)
    }
    if (ev.type === 'request/header' && Array.isArray(ev.data?.header?.tools) && tools.length === 0) {
      tools = ev.data.header.tools
    }
  }
  return { skills, tools }
}

/** How many times each skill was actually invoked, from `skill` tool calls. */
function extractSkillUsage(events) {
  const usage = {}
  for (const ev of events) {
    if (ev.type !== 'tool/call' || ev.data?.name !== 'skill') continue
    let args = {}
    try {
      args = JSON.parse(ev.data.arguments || '{}')
    } catch {}
    const n = args?.name
    if (n) usage[n] = (usage[n] || 0) + 1
  }
  return usage
}

export function apply(ctx, config = {}) {
  const cfg = { ...Config, ...config }
  const OUTPUT_SCHEMA = { type: 'json' }
  const outRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

  const tools = [
    {
      name: 'ctx_budget',
      description:
        'Audit how one session spends its per-turn context budget: break down each turn into the surfaces that inject it (system prompt, AGENTS.md instructions, skill catalog, tool schemas, runtime context, team messages, history), then measure how much of it is the same content resent byte-identically — the part the model does not need to be told again. Also reports the model and context window for scale. Deterministic, no LLM. Returns {ok, session, composition, repetition, perTurn, skills, tools, wasteRatio, report}.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Path to a session.v4.jsonl.zstd file, a session directory, or a session id. Omit to audit the newest session.' },
          dir: { type: 'string', description: 'Sessions root used to resolve a bare session id, and to pick the newest session when none is given. Defaults to ~/.dsh/sessions.' },
        },
      },
      async execute(args) {
        const root = resolveSessionsDir(args.dir)
        let file = args.session ? resolveSessionFile(args.session) : null
        if (args.session && !file) return { ok: false, error: `no session.v4.jsonl.zstd for ${args.session}` }
        if (!file) {
          const newest = listSessions(root, cfg.maxSessions).sort((a, b) => b.name.localeCompare(a.name))[0]
          if (!newest) return { ok: false, error: `no sessions found under ${root}` }
          file = newest.file
        }
        const { events, error } = loadSession(file)
        if (error) return { ok: false, error }
        if (events.length === 0) return { ok: false, error: 'session log is empty' }
        const { skills, tools: toolSchemas } = extractInputs(events)
        const result = auditSession(events, { skills, tools: toolSchemas, usage: extractSkillUsage(events) })
        result.session.file = file
        result.session.workspace = file.split(/[\\/]/).slice(-3, -2)[0] ?? null
        result.report = renderReport(result, { title: `context budget · ${file}` })
        return result
      },
    },
    {
      name: 'ctx_budget_sweep',
      description:
        'Sweep every session under a sessions root and rank them by how much of their injected context is repeated unchanged content, so the worst offenders are the first ones you look at. Read-only; a big history is capped by `limit` (default 30 newest). Returns {ok, sessions:[{name,workspace,turns,injectedTokens,wasteTokens,wasteRatio,topSurface}], totals}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Sessions root. Defaults to ~/.dsh/sessions.' },
          limit: { type: 'integer', description: 'Max sessions to read (default 30).' },
        },
      },
      async execute(args) {
        const root = resolveSessionsDir(args.dir)
        const sessions = listSessions(root, Math.max(1, Number(args.limit) || cfg.maxSessions))
        if (sessions.length === 0) return { ok: false, error: `no sessions found under ${root}` }
        const rows = []
        for (const s of sessions) {
          const { events, error } = loadSession(s.file)
          if (error || events.length === 0) continue
          const turns = buildTurns(events)
          if (turns.length === 0) continue
          const result = auditSession(events, extractInputs(events))
          const top = Object.entries(result.composition.categories).sort((a, b) => b[1].tokens - a[1].tokens)[0]
          rows.push({
            name: s.name,
            workspace: s.workspace,
            turns: result.session.turns,
            injectedTokens: result.composition.totalTokens,
            wasteTokens: result.repetition.wasteTokens,
            wasteRatio: result.wasteRatio,
            topSurface: top ? `${top[0]} ${top[1].tokens}` : null,
          })
        }
        rows.sort((a, b) => b.wasteTokens - a.wasteTokens)
        const totals = rows.reduce(
          (acc, r) => ({ injectedTokens: acc.injectedTokens + r.injectedTokens, wasteTokens: acc.wasteTokens + r.wasteTokens, turns: acc.turns + r.turns }),
          { injectedTokens: 0, wasteTokens: 0, turns: 0 },
        )
        return { ok: true, sessions: rows, totals }
      },
    },
    {
      name: 'ctx_budget_skills',
      description:
        'Skill-catalog governance: how many tokens of skill descriptions the model reads on every single turn, ranked by cost, and which skills should be lazy-loaded (expensive to describe, rarely invoked). With 60+ skills installed the catalog is one of the largest standing costs in the prompt, and it is paid whether or not a skill is ever used. Returns {ok, skills:[{name,tokensPerTurn,uses}], tokensPerTurn, lazyLoad, turns}.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Path to a session.v4.jsonl.zstd file, a session directory, or a session id. Omit to audit the newest session.' },
          dir: { type: 'string', description: 'Sessions root used to resolve a bare session id and to pick the newest session. Defaults to ~/.dsh/sessions.' },
          maxSkills: { type: 'integer', description: 'How many skills to list at most (default 40).' },
        },
      },
      async execute(args) {
        const root = resolveSessionsDir(args.dir)
        let file = args.session ? resolveSessionFile(args.session) : null
        if (args.session && !file) return { ok: false, error: `no session.v4.jsonl.zstd for ${args.session}` }
        if (!file) {
          const newest = listSessions(root, cfg.maxSessions).sort((a, b) => b.name.localeCompare(a.name))[0]
          if (!newest) return { ok: false, error: `no sessions found under ${root}` }
          file = newest.file
        }
        const { events, error } = loadSession(file)
        if (error) return { ok: false, error }
        const { skills } = extractInputs(events)
        if (skills.length === 0) return { ok: false, error: 'no skill catalog found in this session' }
        const usage = extractSkillUsage(events)
        const ranked = skills
          .map((s) => ({ name: s.name, chars: s.chars, tokensPerTurn: tokensForChars(s.chars), uses: usage[s.name] || 0 }))
          .sort((a, b) => b.tokensPerTurn - a.tokensPerTurn)
        const max = Math.max(1, Number(args.maxSkills) || 40)
        const lazy = ranked.filter((s) => s.uses === 0 && s.tokensPerTurn >= 60)
        return {
          ok: true,
          file,
          skills: ranked.slice(0, max),
          totalSkills: ranked.length,
          tokensPerTurn: ranked.reduce((a, s) => a + s.tokensPerTurn, 0),
          lazyLoad: lazy.slice(0, max).map((s) => ({ name: s.name, tokensPerTurn: s.tokensPerTurn, uses: 0 })),
          turns: events.filter((e) => e.type === 'turn/start').length,
        }
      },
    },
    {
      name: 'ctx_budget_tools',
      description:
        'Tool-schema inflation: which tool group occupies the most context on every turn. Tool definitions are sent in full on every request, so a chatty MCP server or a plugin with wide parameters is a standing tax the model pays per turn. Groups are derived from tool-name prefixes (mcp__server__, plugin families, built-ins). Returns {ok, groups:[{group,tools,chars,tokensPerTurn}], totalTokensPerTurn, tools}.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Path to a session.v4.jsonl.zstd file, a session directory, or a session id. Omit to audit the newest session.' },
          dir: { type: 'string', description: 'Sessions root used to resolve a bare session id and to pick the newest session. Defaults to ~/.dsh/sessions.' },
          maxGroups: { type: 'integer', description: 'How many groups to list at most (default 20).' },
        },
      },
      async execute(args) {
        const root = resolveSessionsDir(args.dir)
        let file = args.session ? resolveSessionFile(args.session) : null
        if (args.session && !file) return { ok: false, error: `no session.v4.jsonl.zstd for ${args.session}` }
        if (!file) {
          const newest = listSessions(root, cfg.maxSessions).sort((a, b) => b.name.localeCompare(a.name))[0]
          if (!newest) return { ok: false, error: `no sessions found under ${root}` }
          file = newest.file
        }
        const { events, error } = loadSession(file)
        if (error) return { ok: false, error }
        const { tools } = extractInputs(events)
        if (tools.length === 0) return { ok: false, error: 'no tool schemas found in this session' }
        const inflated = toolInflation(tools)
        const max = Math.max(1, Number(args.maxGroups) || 20)
        return {
          ok: true,
          file,
          groups: inflated.rows.slice(0, max),
          toolCount: tools.length,
          totalChars: inflated.totalChars,
          totalTokensPerTurn: inflated.totalTokens,
        }
      },
    },
  ]

  for (const t of tools) {
    try {
      ctx.tools.register({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        output: { schema: OUTPUT_SCHEMA, render: outRender },
        timeoutMs: 300_000,
        isConcurrencySafe: () => true,
        presentCall: (args) => ({ card: 'generic', title: t.name, kind: 'read', rawInput: args }),
        execute: t.execute,
      })
    } catch (error) {
      console.error(`[context-budget] ${t.name} registration skipped: ${error}`)
    }
  }
}
