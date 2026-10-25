// Integration test: boot the plugin against a fake ctx and drive every tool
// against the real session logs on this machine.
import { apply } from '../lib/index.js'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const registry = new Map()
const fakeCtx = { tools: { register: (t) => registry.set(t.name, t) } }
apply(fakeCtx, { maxSessions: 10 })

const SESSIONS = join(homedir(), '.dsh', 'sessions')

/**
 * Find a session with the full per-turn injection shape we audit:
 * system prompt + skill catalog + request/header. The root has a workspace
 * level between it and the session dirs, so this walks down.
 */
function sessionWithInjection() {
  for (const ws of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    for (const d of readdirSync(join(SESSIONS, ws.name), { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const f = join(SESSIONS, ws.name, d.name, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      try {
        const text = execFileSync('zstd', ['-dc', f], { maxBuffer: 64 * 1024 * 1024 })
        const s = text[0] === 0xff && text[1] === 0xfe ? text.toString('utf16le') : text.toString('utf8')
        if (s.includes('"skill-catalog"') && s.includes('"request/header"') && s.includes('"system/message"')) return f
      } catch {}
    }
  }
  return null
}

const results = []
const call = async (name, args = {}) => registry.get(name).execute(args, { signal: undefined })

try {
  const expected = ['ctx_budget', 'ctx_budget_sweep', 'ctx_budget_skills', 'ctx_budget_tools']
  results.push([`${expected.length} tools registered`, expected.every((n) => registry.has(n))])

  const file = sessionWithInjection()
  results.push(['found a real session with system + skill catalog + tool schemas', file !== null])

  if (file) {
    const audit = await call('ctx_budget', { session: file })
    results.push(['ctx_budget runs on a real session', audit.ok === true && audit.session.turns >= 2])
    results.push(['ctx_budget breaks the budget into surfaces', Object.keys(audit.composition.categories).length >= 3])
    results.push(['ctx_budget measures repetition', audit.repetition.repeated.length > 0 && audit.repetition.wasteTokens > 0])
    results.push(['ctx_budget reports a waste ratio in (0,1)', audit.wasteRatio > 0 && audit.wasteRatio < 1])
    results.push(['ctx_budget carries the model name', typeof audit.session.model === 'string'])
    results.push(['ctx_budget renders a text report', typeof audit.report === 'string' && audit.report.includes('composition')])

    const skills = await call('ctx_budget_skills', { session: file })
    results.push(['ctx_budget_skills lists the catalog', skills.ok === true && skills.totalSkills > 10])
    results.push(['ctx_budget_skills reports a per-turn cost', skills.tokensPerTurn > 0])
    results.push(['ctx_budget_skills finds lazy-load candidates', Array.isArray(skills.lazyLoad) && skills.lazyLoad.length > 0])

    const tools = await call('ctx_budget_tools', { session: file })
    results.push(['ctx_budget_tools groups the schema set', tools.ok === true && tools.groups.length >= 2])
    results.push(['ctx_budget_tools attributes an mcp server', tools.groups.some((g) => g.group.startsWith('mcp:'))])
    results.push(['ctx_budget_tools totals add up', tools.totalTokensPerTurn > 0 && tools.toolCount > 10])
  }

  const sweep = await call('ctx_budget_sweep', { dir: SESSIONS, limit: 8 })
  results.push(['sweep ranks sessions', sweep.ok === true && Array.isArray(sweep.sessions) && sweep.sessions.length > 0])
  results.push(['sweep is sorted by waste', sweep.sessions.every((s, i, a) => i === 0 || a[i - 1].wasteTokens >= s.wasteTokens)])
  results.push(['sweep totals add up', sweep.totals.injectedTokens >= sweep.totals.wasteTokens])

  const missing = await call('ctx_budget', { session: 'Z:/nope/nothing.zstd' })
  results.push(['missing session is an error', missing.ok === false])
  const empty = await call('ctx_budget_sweep', { dir: 'Z:/nope' })
  results.push(['missing sweep root is an error', empty.ok === false])
} catch (error) {
  console.error('UNEXPECTED THROW:', error)
  results.push(['no-throw', false])
}

let pass = 0
for (const [name, ok] of results) {
  console.log(`${ok ? '✔' : '✖'} ${name}`)
  if (ok) pass += 1
}
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
