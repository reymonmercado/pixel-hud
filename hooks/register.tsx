import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Limit, Plan, PlanItem, Run, SubAgent, Tokens } from '../types'

type Status = Run['status']

const PANE = 'spark-progress'

// 8-bit palette: Claude coral on a warm, dark arcade panel.
const CORAL = '#D97757'
const CORAL_HI = '#F0A07F'
const CORAL_LO = '#A9502F'
const CREAM = '#F4EFE6'
const INK = '#2B1B14'
const PANEL = '#1A1410'
const PANEL_HI = '#3A2A22'
const MUTED = '#9A8F85'
const GOOD = '#7FC8A9'
const WARN = '#E8B25A'
const BAD = '#E06C5A'

const runAtom = atom({ plugin: 'spark-progress', key: 'run' } as const, null)
const agentsAtom = atom({ plugin: 'spark-progress', key: 'agents' } as const, [])
const costAtom = atom({ plugin: 'spark-progress', key: 'costUsd' } as const, 0)
const nowAtom = atom({ plugin: 'spark-progress', key: 'now' } as const, 0)
const limitsAtom = atom({ plugin: 'spark-progress', key: 'limits' } as const, [])

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const addUsage = (t: Tokens, u: Usage): Tokens => ({
  input: t.input + u.input_tokens,
  output: t.output + u.output_tokens,
  cacheRead: t.cacheRead + u.cache_read_input_tokens,
  cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
})

const totalTokens = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite

// Relative price weights shared by Claude models (output 5x input, cache read
// 0.1x, cache write 1.25x), used to split the session's real cost by agent.
const weight = (t: Tokens) => t.input + 5 * t.output + 0.1 * t.cacheRead + 1.25 * t.cacheWrite

const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "2D 4H", "3H 12M", "8M": time left until a reset. */
const fmtIn = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}D ${h}H` : h > 0 ? `${h}H ${m % 60}M` : `${m}M`
}

const fmtUsd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// --- plan tracking: TodoWrite and the desktop app's task list ---------------

const isStatus = (s: unknown): s is PlanItem['status'] =>
  s === 'pending' || s === 'in_progress' || s === 'completed'

const toItems = (list: unknown): PlanItem[] | undefined => {
  if (!Array.isArray(list)) return undefined
  return list.map(raw => {
    const one = (raw ?? {}) as Record<string, unknown>
    return {
      content: String(one.activeForm ?? one.content ?? ''),
      status: isStatus(one.status) ? one.status : 'pending',
    }
  })
}

const applyPlanCall = (plan: Plan | undefined, args: Record<string, unknown>): Plan | undefined => {
  const fresh = toItems(args.todos ?? args.items)
  if (fresh) return { items: fresh }
  if (!plan) return plan
  const items = plan.items.map(i => ({ ...i }))
  if (args.advance === true) {
    const at = items.findIndex(i => i.status === 'in_progress')
    if (at >= 0) items[at]!.status = 'completed'
    const nextUp = items.findIndex(i => i.status === 'pending')
    if (nextUp >= 0) items[nextUp]!.status = 'in_progress'
  }
  if (Array.isArray(args.done)) {
    for (const n of args.done) if (typeof n === 'number' && items[n - 1]) items[n - 1]!.status = 'completed'
  }
  if (typeof args.start === 'number' && items[args.start - 1]) {
    items[args.start - 1]!.status = 'in_progress'
  }
  return { items }
}

// --- progress ------------------------------------------------------------------

/** 0..1, or null when the task gives nothing to measure by. */
const progressOf = (run: Run, agents: SubAgent[]): number | null => {
  if (run.status !== 'running') return 1
  if (run.plan && run.plan.items.length > 0) {
    const items = run.plan.items
    const done = items.filter(i => i.status === 'completed').length
    const active = items.filter(i => i.status === 'in_progress').length
    return Math.min(0.99, (done + active * 0.5) / items.length)
  }
  if (agents.length > 0) {
    const done = agents.filter(a => a.status !== 'running').length
    return Math.min(0.95, (done + 0.5) / (agents.length + 1))
  }
  return null
}

/** Refreshes the session's spend and the plan's usage windows. */
const refreshUsage = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  if (usage.cost) await update($, costAtom, () => usage.cost!.usd)
  await update($, limitsAtom, () => usage.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })))
  return usage.cost?.usd
}

// --- 8-bit drawing kit (SVG for the desktop, editor and mobile) --------------

// A 3x5 pixel font: each glyph is five rows of three bits.
const FONT: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
  E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
  I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
  Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111',
  '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010',
  '8': '111101111101111', '9': '111101111001110',
  ' ': '000000000000000', '.': '000000000000010', ',': '000000000010100', ':': '000010000010000',
  $: '011110010011110', '%': '101001010100101', '/': '001001010100100', '-': '000000111000000',
  '!': '010010010000010', '?': '110001010000010', '(': '010100100100010', ')': '010001001001010',
  '+': '000010111010000', '>': '100010001010100', _: '000000000000111', '~': '000000011110000',
  '#': '101111101111101', '·': '000000010000000', '…': '000000000000101', "'": '010010000000000',
}

const px = (x: number, y: number, s: number) => `M${x} ${y}h${s}v${s}h-${s}z`

/** Text in the pixel font; `scale` is the size of one font pixel. */
const pixelText = (text: string, x: number, y: number, scale: number, fill: string) => {
  let d = ''
  let cx = x
  for (const ch of text.toUpperCase().replace(/≈/g, '~')) {
    const glyph = FONT[ch] ?? FONT['?']!
    for (let i = 0; i < 15; i++) {
      if (glyph[i] === '1') d += px(cx + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale)
    }
    cx += 4 * scale
  }
  return d ? `<path fill="${fill}" d="${d}"/>` : ''
}

const textWidth = (text: string, scale: number) => text.length * 4 * scale - scale

/** A sprite from rows of characters, each mapped to a colour ('.' is clear). */
const sprite = (rows: string[], x: number, y: number, s: number, colors: Record<string, string>) => {
  const paths: Record<string, string> = {}
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const color = colors[row[c]!]
      if (color) paths[color] = (paths[color] ?? '') + px(x + c * s, y + r * s, s)
    }
  })
  return Object.entries(paths)
    .map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`)
    .join('')
}

// The mascot: a little coral critter, 16 by 9 pixels, with two walk frames.
const BODY = [
  '..hhhhhhhhhhhh..',
  '..bbbbbbbbbbbb..',
  '..bbeebbbbeebb..',
  '..bbeebbbbeebb..',
  'bbbbbbbbbbbbbbbb',
  'bbbbbbbbbbbbbbbb',
  '..llllllllllll..',
]
const EYES_SHUT = ['..bbbbbbbbbbbb..', '..bbeebbbbeebb..']
const EYES_HAPPY = ['..bbeebbbbeebb..', '..bebbebbebbeb..']
const LEGS_A = ['..b.b......b.b..', '..b.b......b.b..']
const LEGS_B = ['...b.b....b.b...', '...b.b....b.b...']

type Mood = 'walk' | 'happy' | 'sad' | 'sleep'

const mascotColors = (mood: Mood) => ({
  h: mood === 'sad' ? MUTED : CORAL_HI,
  b: mood === 'sad' ? '#8A6F62' : CORAL,
  l: mood === 'sad' ? '#6A5248' : CORAL_LO,
  e: INK,
})

const mascotRows = (mood: Mood, legs: string[]) => {
  const body = [...BODY]
  if (mood === 'sleep') body.splice(2, 2, ...EYES_SHUT)
  if (mood === 'happy') body.splice(2, 2, ...EYES_HAPPY)
  return [...body, ...legs]
}

/** The mascot at (x, y), animated by its mood; `s` is its pixel size. */
const mascot = (x: number, y: number, s: number, mood: Mood) => {
  const colors = mascotColors(mood)
  if (mood === 'walk') {
    const a = sprite(mascotRows(mood, LEGS_A), x, y, s, colors)
    const b = sprite(mascotRows(mood, LEGS_B), x, y, s, colors)
    return `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -${s};0 0" dur=".5s" calcMode="discrete" repeatCount="indefinite"/>
      <g>${a}<animate attributeName="opacity" values="1;0" dur=".5s" calcMode="discrete" repeatCount="indefinite"/></g>
      <g opacity="0">${b}<animate attributeName="opacity" values="0;1" dur=".5s" calcMode="discrete" repeatCount="indefinite"/></g></g>`
  }
  const still = sprite(mascotRows(mood, LEGS_A), x, y, s, colors)
  if (mood === 'happy') {
    return `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -${s * 3};0 0;0 0" dur="1s" calcMode="discrete" repeatCount="indefinite"/>${still}</g>`
  }
  if (mood === 'sleep') {
    return `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 ${s};0 0" dur="2s" calcMode="discrete" repeatCount="indefinite"/>${still}</g>`
  }
  return still
}

/** A four-point pixel sparkle that twinkles. */
const sparkle = (x: number, y: number, s: number, color: string, delay: number) =>
  `<g opacity="0">${sprite(['.x.', 'xxx', '.x.'], x, y, s, { x: color })}<animate attributeName="opacity" values="0;1;0" dur="1.4s" begin="${delay}s" calcMode="discrete" repeatCount="indefinite"/></g>`

/** A dark arcade panel with a chunky two-tone pixel border. */
const frame = (w: number, h: number, accent: string) =>
  `<rect x="0" y="0" width="${w}" height="${h}" fill="${PANEL}"/>
   <path fill="${accent}" d="M3 0h${w - 6}v3h-${w - 6}zM3 ${h - 3}h${w - 6}v3h-${w - 6}zM0 3h3v${h - 6}h-3zM${w - 3} 3h3v${h - 6}h-3z"/>
   <path fill="${PANEL_HI}" d="M6 6h${w - 12}v2h-${w - 12}zM6 ${h - 8}h${w - 12}v2h-${w - 12}z"/>`

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${body}</svg>`

/** A segmented progress bar; a null `pct` sweeps a lit block back and forth. */
const segBar = (x: number, y: number, w: number, h: number, segs: number, pct: number | null, color: string) => {
  const gap = 2
  const sw = (w - gap * (segs - 1)) / segs
  const lit = pct === null ? 0 : Math.round(Math.min(1, pct) * segs)
  let out = ''
  for (let i = 0; i < segs; i++) {
    const sx = (x + i * (sw + gap)).toFixed(1)
    const isLit = i < lit
    out += `<rect x="${sx}" y="${y}" width="${sw.toFixed(1)}" height="${h}" fill="${isLit ? color : PANEL_HI}"/>`
    if (isLit) out += `<rect x="${sx}" y="${y}" width="${sw.toFixed(1)}" height="2" fill="#FFFFFF" fill-opacity=".35"/>`
  }
  if (pct === null) {
    const blockW = sw * 3 + gap * 2
    out += `<rect x="${x}" y="${y}" width="${blockW.toFixed(1)}" height="${h}" fill="${color}">
      <animate attributeName="x" values="${x};${(x + w - blockW).toFixed(1)};${x}" dur="2.4s" repeatCount="indefinite"/></rect>`
  }
  return out
}

const STARS: [number, number][] = [[24, 34], [70, 44], [130, 32], [196, 42], [250, 30], [312, 40], [340, 56], [96, 60]]

/** The main scene: title, percent, the mascot walking along the track. */
const sceneSvg = (pct: number | null, status: Status | 'idle', title: string) => {
  const W = 360
  const H = 128
  const S = 3
  const trackX = 18
  const trackW = W - 36
  const trackY = 100
  const mw = 16 * S
  const mh = 9 * S
  const isRunning = status === 'running'
  const accent = status === 'error' ? BAD : status === 'stopped' ? MUTED : CORAL
  const stars = STARS.map(([x, y], i) => sparkle(x, y, 2, i % 2 ? CREAM : CORAL_HI, i * 0.35)).join('')
  const pctText = status === 'idle' ? '' : pct === null ? '...' : `${Math.round(pct * 100)}%`
  const groundY = trackY - mh - 4

  let hero: string
  if (status === 'idle') {
    const x = (W - mw) / 2
    const zs = [0, 1, 2]
      .map(i => `<g opacity="0">${pixelText('z', x + mw + 4 + i * 10, groundY - 4 - i * 8, 2 + i, CREAM)}<animate attributeName="opacity" values="0;1;1;0" dur="2.4s" begin="${i * 0.6}s" repeatCount="indefinite"/></g>`)
      .join('')
    hero = mascot(x, groundY, S, 'sleep') + zs
  } else if (isRunning && pct === null) {
    hero = `<g>${mascot(trackX, groundY, S, 'walk')}<animateTransform attributeName="transform" type="translate" values="0 0;${trackW - mw} 0;0 0" dur="6s" repeatCount="indefinite" additive="sum"/></g>`
  } else if (isRunning) {
    hero = mascot(trackX + (pct ?? 0) * (trackW - mw), groundY, S, 'walk')
  } else {
    const x = trackX + trackW - mw - 14
    const mood: Mood = status === 'done' ? 'happy' : 'sad'
    const fireworks =
      status === 'done'
        ? [sparkle(x - 18, groundY - 10, 3, CORAL_HI, 0), sparkle(x + mw + 4, groundY - 16, 3, CREAM, 0.4), sparkle(x - 36, groundY + 4, 2, GOOD, 0.8)].join('')
        : ''
    hero = mascot(x, groundY, S, mood) + fireworks
  }

  const flag = sprite(['f...', 'ffff', 'fff.', 'ff..', 'f...', 'f...', 'f...', 'f...'], trackX + trackW - 10, trackY - 26, 3, { f: CREAM })

  return svg(
    W,
    H,
    `${frame(W, H, accent)}${stars}
     ${pixelText(clip(title, 22), 16, 16, 3, accent)}
     ${pctText ? pixelText(pctText, W - 16 - textWidth(pctText, 3), 16, 3, CREAM) : ''}
     ${status === 'idle' ? '' : flag}
     ${hero}
     <rect x="${trackX - 2}" y="${trackY - 2}" width="${trackW + 4}" height="18" fill="${INK}"/>
     ${segBar(trackX, trackY, trackW, 14, 24, status === 'idle' ? 0 : pct, accent)}`,
  )
}

/** The stats HUD: six pixel boxes. */
const hudSvg = (stats: [string, string][]) => {
  const W = 360
  const cols = 3
  const bw = 116
  const bh = 42
  const gap = 6
  const rows = Math.ceil(stats.length / cols)
  const H = rows * bh + (rows - 1) * gap
  const boxes = stats
    .map(([k, v], i) => {
      const x = (i % cols) * (bw + gap)
      const y = Math.floor(i / cols) * (bh + gap)
      const scale = textWidth(v, 3) <= bw - 16 ? 3 : 2
      return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${PANEL}"/>
        <path fill="${PANEL_HI}" d="M${x} ${y}h${bw}v2h-${bw}zM${x} ${y + bh - 2}h${bw}v2h-${bw}zM${x} ${y}h2v${bh}h-2zM${x + bw - 2} ${y}h2v${bh}h-2z"/>
        <rect x="${x + 2}" y="${y + 2}" width="4" height="4" fill="${CORAL}"/>
        ${pixelText(k, x + 10, y + 7, 2, MUTED)}
        ${pixelText(v, x + 8, y + 21, scale, CREAM)}`
    })
    .join('')
  return svg(W, H, boxes)
}

const limitName = (kind: string) =>
  kind === 'five_hour' ? 'SESSION (5H)' : kind === 'seven_day' ? 'THIS WEEK' : kind === 'spend_limit' ? 'SPEND LIMIT' : kind.replace(/_/g, ' ')

const meterColor = (pct: number) => (pct >= 90 ? BAD : pct >= 70 ? WARN : GOOD)

/** Plan usage as 8-bit energy meters, with the session's spend on top. */
const usageSvg = (limits: Limit[], sessionUsd: number, now: number) => {
  const W = 360
  const rowH = 40
  const top = 34
  const H = top + Math.max(1, limits.length) * rowH + 8
  const heart = sprite(['.x.x.', 'xxxxx', 'xxxxx', '.xxx.', '..x..'], 14, 12, 3, { x: CORAL })
  let rows = ''
  if (limits.length === 0) {
    rows = pixelText('NO PLAN LIMITS REPORTED YET', 16, top + 12, 2, MUTED)
  }
  limits.forEach((l, i) => {
    const y = top + i * rowH
    const pct = Math.max(0, l.percentUsed)
    const color = meterColor(pct)
    const pctText = `${Math.round(pct)}%`
    const resetMs = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN
    const reset = Number.isFinite(resetMs) ? `RESETS IN ${fmtIn(resetMs)}` : ''
    rows += `${pixelText(limitName(l.kind), 16, y, 2, CREAM)}
      ${pixelText(pctText, W - 16 - textWidth(pctText, 2), y, 2, color)}
      <rect x="14" y="${y + 13}" width="${W - 28}" height="14" fill="${INK}"/>
      ${segBar(16, y + 15, W - 32, 10, 20, pct / 100, color)}
      ${reset ? pixelText(reset, 16, y + 30, 1, MUTED) : ''}`
  })
  const spend = `SESSION SPEND ${fmtUsd(sessionUsd)}`
  return svg(
    W,
    H,
    `${frame(W, H, CORAL)}${heart}
     ${pixelText('USAGE', 34, 13, 3, CORAL)}
     ${pixelText(spend, W - 16 - textWidth(spend, 2), 15, 2, CREAM)}
     ${rows}`,
  )
}

/** The plan as a pixel checklist. */
const planSvg = (items: PlanItem[]) => {
  const W = 360
  const rowH = 18
  const H = items.length * rowH + 8
  const rows = items
    .map((item, i) => {
      const y = 4 + i * rowH
      const color = item.status === 'completed' ? MUTED : item.status === 'in_progress' ? CORAL : CREAM
      const box =
        item.status === 'completed'
          ? sprite(['xxxxx', 'x...x', 'x..cx', 'xccxx', 'xxxxx'], 6, y + 2, 2, { x: MUTED, c: GOOD })
          : item.status === 'in_progress'
            ? `<g>${sprite(['.x.', 'xxx', '.x.'], 6, y + 2, 3, { x: CORAL })}<animate attributeName="opacity" values="1;.3;1" dur="1s" calcMode="discrete" repeatCount="indefinite"/></g>`
            : sprite(['xxxxx', 'x...x', 'x...x', 'x...x', 'xxxxx'], 6, y + 2, 2, { x: PANEL_HI })
      return `${box}${pixelText(clip(item.content, 40), 24, y + 2, 2, color)}`
    })
    .join('')
  return svg(W, H, `<rect width="${W}" height="${H}" fill="${PANEL}"/>${rows}`)
}

/** One subagent: a small mascot, its name, status badge and bar. */
const agentSvg = (a: SubAgent, idx: number) => {
  const W = 360
  const H = 56
  const isRunning = a.status === 'running'
  const accent = a.status === 'error' ? BAD : a.status === 'stopped' ? MUTED : CORAL
  const mood: Mood = isRunning ? 'walk' : a.status === 'done' ? 'happy' : 'sad'
  const badge = isRunning ? 'RUN' : a.status === 'done' ? 'DONE' : a.status === 'stopped' ? 'STOP' : 'ERR'
  const badgeColor = isRunning ? CORAL : a.status === 'done' ? GOOD : BAD
  const bw = textWidth(badge, 2) + 8
  return svg(
    W,
    H,
    `${frame(W, H, accent)}
     ${mascot(10, 18, 2, mood)}
     ${pixelText(`#${idx + 1} ${clip(a.description, 22)}`, 50, 12, 2, CREAM)}
     ${pixelText(clip(a.type, 18), 50, 26, 2, MUTED)}
     <rect x="${W - 12 - bw}" y="9" width="${bw}" height="16" fill="${badgeColor}"/>
     ${pixelText(badge, W - 8 - bw, 12, 2, INK)}
     ${segBar(50, 40, W - 62, 7, 16, isRunning ? null : 1, accent)}`,
  )
}

// Text art for the terminal, which has no Svg.
const textBar = (pct: number | null, width: number, frame: number) => {
  if (pct === null) {
    const pos = frame % (width * 2 - 4)
    const at = pos < width - 2 ? pos : width * 2 - 4 - pos
    return Array.from({ length: width }, (_, i) => (i >= at && i < at + 3 ? '▰' : '▱')).join('')
  }
  const full = Math.round(Math.min(1, pct) * width)
  return '▰'.repeat(full) + '▱'.repeat(width - full)
}

const TERM_MASCOT = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝']
const TERM_MASCOT_STEP = [' ▐▛███▜▌', '▝▜█████▛▘', '   ▘▘ ▝▝']

const SPARK_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

// --- the mod ------------------------------------------------------------------

let ticker: Timer | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'Show the Claude task progress pane (subagents, tokens, cost, time, usage)',
    })
    void $.ui.open({ id: PANE, title: 'Claude progress' })
    const started = await next(e)
    await update($, nowAtom, () => Date.now())
    await refreshUsage($)
    return started
  })

  on('command.run', { command: 'progress' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Claude progress' })
    await refreshUsage($)
    return { text: 'Claude progress pane opened.' }
  })

  on('session.measure', async ($, e, next) => {
    if (e.cost) await update($, costAtom, () => e.cost!.usd)
    await update($, limitsAtom, () => e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    const now = await $.clock.now()
    const cost = (await refreshUsage($)) ?? (await read($, costAtom))
    await update($, agentsAtom, () => [])
    await update($, nowAtom, () => now)
    await update($, runAtom, () => ({
      turnId: e.turnId,
      prompt: e.text,
      startedAt: now,
      status: 'running',
      steps: 0,
      tools: 0,
      tokens: zero(),
      costAtStart: cost,
    }))
    ticker?.cancel()
    ticker = $.clock.every(1000, () => {
      void $.clock.now().then(t => update($, nowAtom, () => t))
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const usage = r.usage
    if (e.agentId === undefined) {
      await update($, runAtom, run =>
        run ? { ...run, steps: run.steps + 1, tokens: usage ? addUsage(run.tokens, usage) : run.tokens } : run,
      )
    } else {
      const id = e.agentId
      await update($, agentsAtom, list =>
        list.map(a =>
          a.agentId === id
            ? { ...a, steps: a.steps + 1, model: usage?.model ?? a.model, tokens: usage ? addUsage(a.tokens, usage) : a.tokens }
            : a,
        ),
      )
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const name = String(e.tool)
    if (e.agentId === undefined) {
      await update($, runAtom, run => {
        if (!run) return run
        const isPlan = name === 'TodoWrite' || name.endsWith('__update_plan')
        return {
          ...run,
          tools: run.tools + 1,
          lastTool: isPlan ? run.lastTool : name,
          plan: isPlan ? applyPlanCall(run.plan, args) : run.plan,
        }
      })
    } else {
      const id = e.agentId
      await update($, agentsAtom, list =>
        list.map(a => (a.agentId === id ? { ...a, tools: a.tools + 1, lastTool: name } : a)),
      )
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const key = `${e.tool_use_id}:${e.description}`
    const startedAt = await $.clock.now()
    await update($, agentsAtom, list => [
      ...list,
      {
        key,
        description: e.description || e.subagentType,
        type: e.subagentType,
        model: e.model,
        startedAt,
        status: 'running' as Status,
        steps: 0,
        tools: 0,
        tokens: zero(),
      },
    ])
    const r = await next(e)
    await update($, agentsAtom, list =>
      list.map(a =>
        a.key === key
          ? { ...a, agentId: r.agentId, model: r.model, status: r.agentId ? a.status : 'done', endedAt: r.agentId ? a.endedAt : startedAt }
          : a,
      ),
    )
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const endedAt = await $.clock.now()
    const status: Status = e.reason === 'aborted' ? 'stopped' : e.reason === 'answer' ? 'done' : 'error'
    await refreshUsage($)
    if (e.agentId !== undefined) {
      const id = e.agentId
      await update($, agentsAtom, list =>
        list.map(a => (a.agentId === id ? { ...a, status, endedAt } : a)),
      )
    } else {
      await update($, runAtom, run => (run && run.turnId === e.turnId ? { ...run, status, endedAt } : run))
      const agents = await read($, agentsAtom)
      if (!agents.some(a => a.status === 'running')) {
        ticker?.cancel()
        ticker = undefined
      }
    }
    await update($, nowAtom, () => endedAt)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const Svg = e.surface !== 'terminal' && 'Svg' in el ? el.Svg : undefined
    const run = await read($, runAtom)
    const agents = await read($, agentsAtom)
    const costUsd = await read($, costAtom)
    const limits = await read($, limitsAtom)
    const now = await read($, nowAtom)
    const frame = Math.floor(now / 1000)
    const width = Math.max(10, Math.min(40, (e.viewport?.columns ?? 50) - 14))
    const termMascot = (moving: boolean) => (
      <Box flexDirection="column">
        {(moving && frame % 2 ? TERM_MASCOT_STEP : TERM_MASCOT).map(line => (
          <Text color="claude">{line}</Text>
        ))}
      </Box>
    )

    const usageView = Svg ? (
      <Svg
        source={usageSvg(limits, costUsd, now)}
        alt={`Usage: session spend ${fmtUsd(costUsd)}; ${limits.map(l => `${limitName(l.kind)} ${Math.round(l.percentUsed)}%`).join(', ') || 'no plan limits reported'}`}
      />
    ) : (
      <Box flexDirection="column">
        <Text weight="semibold" color="claude">♥ Usage · session spend {fmtUsd(costUsd)}</Text>
        {limits.length === 0 && <Text dimColor>No plan limits reported yet.</Text>}
        {limits.map(l => {
          const resetMs = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN
          return (
            <Text>
              {limitName(l.kind).padEnd(13)} <Text color={l.percentUsed >= 90 ? 'error' : l.percentUsed >= 70 ? 'warning' : 'success'}>{textBar(l.percentUsed / 100, Math.min(20, width), 0)}</Text> {Math.round(l.percentUsed)}%
              {Number.isFinite(resetMs) ? <Text dimColor> · resets in {fmtIn(resetMs).toLowerCase()}</Text> : ''}
            </Text>
          )
        })}
      </Box>
    )

    if (!run) {
      return (
        <Box flexDirection="column" padding={1} gap={1}>
          {Svg ? (
            <Svg source={sceneSvg(0, 'idle', 'CLAUDE IS READY')} alt="The Claude mascot napping: no task running" isInteractive />
          ) : (
            <Box flexDirection="row" gap={2} alignItems="center">
              {termMascot(false)}
              <Text color="claude" weight="bold">Claude is ready  z z z</Text>
            </Box>
          )}
          <Text dimColor>Send a prompt and its progress, subagents, tokens, cost and time show here.</Text>
          {usageView}
        </Box>
      )
    }

    const isRunning = run.status === 'running'
    const pct = progressOf(run, agents)
    const elapsed = (run.endedAt ?? now) - run.startedAt
    const runCost = Math.max(0, costUsd - run.costAtStart)
    const allTokens = agents.reduce((n, a) => n + totalTokens(a.tokens), totalTokens(run.tokens))
    const allWeight = agents.reduce((n, a) => n + weight(a.tokens), weight(run.tokens)) || 1
    const title =
      run.status === 'running' ? 'WORKING' : run.status === 'done' ? 'TASK CLEAR!' : run.status === 'stopped' ? 'STOPPED' : 'GAME OVER'
    const label = `${title}${pct === null ? '' : ` ${Math.round(pct * 100)}%`}`
    const current = run.plan?.items.find(i => i.status === 'in_progress')?.content
    const stats: [string, string][] = [
      ['TIME', fmtTime(elapsed)],
      ['COST', fmtUsd(runCost)],
      ['TOKENS', fmtTokens(allTokens)],
      ['STEPS', String(run.steps)],
      ['TOOLS', String(run.tools)],
      ['AGENTS', String(agents.length)],
    ]

    return (
      <Box flexDirection="column" padding={1} gap={1}>
        {Svg ? (
          <Svg source={sceneSvg(pct, run.status, title)} alt={`The Claude mascot on the progress track: ${label}`} isInteractive />
        ) : (
          <Box flexDirection="row" gap={2} alignItems="center">
            {termMascot(isRunning)}
            <Box flexDirection="column">
              <Text color="claude" weight="bold">
                {isRunning ? SPARK_FRAMES[frame % SPARK_FRAMES.length] : '✻'} {label}
              </Text>
              <Text color="claude">{textBar(pct, width, frame)}</Text>
            </Box>
          </Box>
        )}

        <Text dimColor>{clip(run.prompt || '(continuing)', 120)}</Text>
        {current && <Text color="claude">▸ {clip(current, 80)}</Text>}

        {Svg ? (
          <Svg source={hudSvg(stats)} alt={stats.map(([k, v]) => `${k} ${v}`).join(', ')} />
        ) : (
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {stats.map(([k, v]) => (
              <Box flexDirection="column" minWidth={70}>
                <Text size="caption" dimColor>{k}</Text>
                <Text weight="semibold" tabular mono>{v}</Text>
              </Box>
            ))}
          </Box>
        )}

        <Text size="caption" dimColor>
          in {fmtTokens(run.tokens.input)} · out {fmtTokens(run.tokens.output)} · cache read {fmtTokens(run.tokens.cacheRead)} · cache write {fmtTokens(run.tokens.cacheWrite)} (main){run.lastTool ? ` · last tool ${run.lastTool}` : ''}
        </Text>

        {run.plan && run.plan.items.length > 0 && (
          <Box flexDirection="column">
            <Text weight="semibold">Quest log</Text>
            {Svg ? (
              <Svg
                source={planSvg(run.plan.items)}
                alt={run.plan.items.map(i => `${i.status}: ${i.content}`).join('; ')}
                isInteractive
              />
            ) : (
              run.plan.items.map(i => (
                <Text dimColor={i.status === 'completed'} color={i.status === 'in_progress' ? 'claude' : undefined}>
                  {i.status === 'completed' ? '■' : i.status === 'in_progress' ? '▶' : '□'} {clip(i.content, 70)}
                </Text>
              ))
            )}
          </Box>
        )}

        {agents.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Text weight="semibold">Party (subagents)</Text>
            {agents.map((a, idx) => {
              const aRunning = a.status === 'running'
              const aCost = runCost * (weight(a.tokens) / allWeight)
              const aTime = (a.endedAt ?? now) - a.startedAt
              const detail = `${a.status} · ${fmtTime(aTime)} · ${fmtTokens(totalTokens(a.tokens))} tokens · ≈${fmtUsd(aCost)} · ${a.steps} steps · ${a.tools} tools${a.model ? ` · ${a.model}` : ''}${a.lastTool ? ` · ${a.lastTool}` : ''}`
              return (
                <Box key={a.key} flexDirection="column">
                  {Svg ? (
                    <Svg source={agentSvg(a, idx)} alt={`Subagent ${a.description}: ${a.status}`} isInteractive />
                  ) : (
                    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
                      <Text weight="semibold">
                        {aRunning ? SPARK_FRAMES[frame % SPARK_FRAMES.length] : a.status === 'done' ? '✓' : '✗'} {clip(a.description, 50)}{' '}
                        <Text dimColor>({a.type})</Text>
                      </Text>
                      <Text color="claude">{textBar(aRunning ? null : 1, width, frame)}</Text>
                    </Box>
                  )}
                  <Text size="caption" dimColor tabular>{detail}</Text>
                </Box>
              )
            })}
          </Box>
        )}

        {usageView}

        <Text size="footnote" dimColor>
          Task cost is the session's real spend since this prompt; per-subagent cost is an estimate split by token weight.
        </Text>
      </Box>
    )
  })
}
