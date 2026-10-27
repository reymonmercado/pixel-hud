import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Limit, Plan, PlanItem, Run, SubAgent, Tokens } from '../types'

type Status = Run['status']

const PANE = 'pixel-hud'

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

const runAtom = atom({ plugin: 'pixel-hud', key: 'run' } as const, null)
const agentsAtom = atom({ plugin: 'pixel-hud', key: 'agents' } as const, [])
const costAtom = atom({ plugin: 'pixel-hud', key: 'costUsd' } as const, 0)
const nowAtom = atom({ plugin: 'pixel-hud', key: 'now' } as const, 0)
const limitsAtom = atom({ plugin: 'pixel-hud', key: 'limits' } as const, [])

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

// A 5x7 pixel font in the style of 8-bit computers and LCD panels: each glyph
// is seven rows (nine for a letter with a descender), each row five bits
// written as two hex digits.
const FONT: Record<string, string> = {
  A: '0E1111 1F1111 11', B: '1E1111 1E1111 1E', C: '0E1110 101011 0E', D: '1C1211 111112 1C',
  E: '1F1010 1E1010 1F', F: '1F1010 1E1010 10', G: '0E1110 171111 0F', H: '111111 1F1111 11',
  I: '0E0404 040404 0E', J: '070202 020212 0C', K: '111214 181412 11', L: '101010 101010 1F',
  M: '111B15 151111 11', N: '111119 151311 11', O: '0E1111 111111 0E', P: '1E1111 1E1010 10',
  Q: '0E1111 111512 0D', R: '1E1111 1E1412 11', S: '0F1010 0E0101 1E', T: '1F0404 040404 04',
  U: '111111 111111 0E', V: '111111 11110A 04', W: '111111 151515 0A', X: '11110A 040A11 11',
  Y: '111111 0A0404 04', Z: '1F0102 040810 1F',
  a: '00000E 010F11 0F', b: '101016 191111 1E', c: '00000E 101011 0E', d: '01010D 131111 0F',
  e: '00000E 111F10 0E', f: '060908 1C0808 08', g: '00000F 11110F 01010E', h: '101016 191111 11',
  i: '04000C 040404 0E', j: '020006 020202 02120C', k: '101012 141814 12', l: '0C0404 040404 0E',
  m: '00001A 151511 11', n: '000016 191111 11', o: '00000E 111111 0E', p: '00001E 11111E 101010',
  q: '00000F 11110F 010101', r: '000016 191010 10', s: '00000E 100E01 1E', t: '08081C 080809 06',
  u: '000011 111113 0D', v: '000011 11110A 04', w: '000011 111515 0A', x: '000011 0A040A 11',
  y: '000011 11110F 01010E', z: '00001F 020408 1F',
  '0': '0E1113 151911 0E', '1': '040C04 040404 0E', '2': '0E1101 020408 1F', '3': '1F0204 020111 0E',
  '4': '02060A 121F02 02', '5': '1F101E 010111 0E', '6': '060810 1E1111 0E', '7': '1F0102 040808 08',
  '8': '0E1111 0E1111 0E', '9': '0E1111 0F0102 0C',
  '.': '000000 00000C 0C', ',': '000000 000C04 08', ':': '000C0C 000C0C 00', ';': '000C0C 000C04 08',
  '!': '040404 040400 04', '?': '0E1101 020400 04', $: '040F14 0E051E 04', '%': '181902 040813 03',
  '/': '000102 040810 00', '-': '000000 1F0000 00', '+': '000404 1F0404 00', '(': '020408 080804 02',
  ')': '080402 020204 08', "'": '0C0408 000000 00', '"': '0A0A0A 000000 00', '~': '000008 150200 00',
  '#': '0A0A1F 0A1F0A 0A', '*': '000415 0E1504 00', '=': '00001F 001F00 00', _: '000000 000000 1F',
  '>': '080402 010204 08', '<': '020408 100804 02', '&': '0C1214 081512 0D', '@': '0E1101 0D1515 0E',
  '[': '0E0808 080808 0E', ']': '0E0202 020202 0E', '·': '000000 040000 00', '…': '000000 000000 15',
  '|': '040404 040404 04', '`': '080400 000000 00',
}

const GLYPH_W = 5
/** Pixels from one character to the next: the glyph and one column of space. */
const ADVANCE = GLYPH_W + 1

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const px = (x: number, y: number) => `M${x} ${y}h1v1h-1z`

const glyphPath = (ch: string) => {
  const rows = FONT[ch]!.replace(/ /g, '')
  let d = ''
  for (let r = 0; r < rows.length / 2; r++) {
    const bits = parseInt(rows.slice(r * 2, r * 2 + 2), 16)
    for (let c = 0; c < GLYPH_W; c++) if (bits & (1 << (GLYPH_W - 1 - c))) d += px(c, r)
  }
  return d
}

const normText = (t: string) => t.replace(/≈/g, '~').replace(/[—–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')

const textWidth = (text: string, scale: number) => normText(text).length * ADVANCE * scale - scale

type Mood = 'walkA' | 'walkB' | 'happy' | 'sad' | 'sleep'

// The mascot: a little coral critter, 16 by 9 pixels.
const BODY = [
  '..hhhhhhhhhhhh..',
  '..bbbbbbbbbbbb..',
  '..bbeebbbbeebb..',
  '..bbeebbbbeebb..',
  'bbbbbbbbbbbbbbbb',
  'bbbbbbbbbbbbbbbb',
  '..llllllllllll..',
]
const EYES: Partial<Record<Mood, string[]>> = {
  sleep: ['..bbbbbbbbbbbb..', '..bbeebbbbeebb..'],
  happy: ['..bbeebbbbeebb..', '..bebbebbebbeb..'],
}
const LEGS_A = ['..b.b......b.b..', '..b.b......b.b..']
const LEGS_B = ['...b.b....b.b...', '...b.b....b.b...']

const mascotRows = (mood: Mood) => {
  const body = [...BODY]
  const eyes = EYES[mood]
  if (eyes) body.splice(2, 2, ...eyes)
  return [...body, ...(mood === 'walkB' ? LEGS_B : LEGS_A)]
}

const mascotColors = (mood: Mood): Record<string, string> =>
  mood === 'sad'
    ? { h: MUTED, b: '#8A6F62', l: '#6A5248', e: INK }
    : { h: CORAL_HI, b: CORAL, l: CORAL_LO, e: INK }

/**
 * One SVG document under construction: glyphs and sprites are defined once in
 * <defs> and placed with <use>, which keeps the markup small.
 */
class Pix {
  private glyphs = new Set<string>()
  private sprites = new Map<string, string>()

  /** Pixel-font text; `scale` is the size of one font pixel. */
  text(text: string, x: number, y: number, scale: number, fill: string) {
    let out = `<g transform="translate(${x} ${y}) scale(${scale})" fill="${fill}">`
    ;[...normText(text)].forEach((ch, i) => {
      if (!FONT[ch]) return
      this.glyphs.add(ch)
      out += `<use href="#g${ch.codePointAt(0)}" x="${i * ADVANCE}"/>`
    })
    return `${out}</g>`
  }

  /** A sprite from rows of characters, each mapped to a colour ('.' is clear). */
  sprite(id: string, rows: string[], colors: Record<string, string>, x: number, y: number, s: number) {
    if (!this.sprites.has(id)) {
      const paths: Record<string, string> = {}
      rows.forEach((row, r) => {
        for (let c = 0; c < row.length; c++) {
          const color = colors[row[c]!]
          if (color) paths[color] = (paths[color] ?? '') + px(c, r)
        }
      })
      const body = Object.entries(paths).map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`).join('')
      this.sprites.set(id, `<g id="${id}">${body}</g>`)
    }
    return `<use href="#${id}" transform="translate(${x} ${y}) scale(${s})"/>`
  }

  mascot(mood: Mood, x: number, y: number, s: number) {
    return this.sprite(`m-${mood}`, mascotRows(mood), mascotColors(mood), x, y, s)
  }

  /** The mascot walking in place: two frames, a bob, legs swapping. */
  walker(x: number, y: number, s: number) {
    return `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -${s};0 0" dur=".5s" calcMode="discrete" repeatCount="indefinite"/>
      <g>${this.mascot('walkA', x, y, s)}<animate attributeName="opacity" values="1;0" dur=".5s" calcMode="discrete" repeatCount="indefinite"/></g>
      <g opacity="0">${this.mascot('walkB', x, y, s)}<animate attributeName="opacity" values="0;1" dur=".5s" calcMode="discrete" repeatCount="indefinite"/></g></g>`
  }

  sparkle(x: number, y: number, s: number, color: string, delay: number) {
    const id = `sp-${color.slice(1)}`
    return `<g opacity="0">${this.sprite(id, ['.x.', 'xxx', '.x.'], { x: color }, x, y, s)}<animate attributeName="opacity" values="0;1;0" dur="1.4s" begin="${delay}s" calcMode="discrete" repeatCount="indefinite"/></g>`
  }

  svg(w: number, h: number, body: string) {
    const glyphs = [...this.glyphs].map(ch => `<path id="g${ch.codePointAt(0)}" d="${glyphPath(ch)}"/>`).join('')
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"><defs>${glyphs}${[...this.sprites.values()].join('')}</defs>${body}</svg>`
  }
}

// Drawn at about the pane's own width, so a font pixel is a screen pixel or
// more: SMALL for fine print, BODY for text, BIG for titles and numbers.
const W = 340
const GAP = 10
const PAD = 12
const T_BODY = 2
const T_BIG = 3
const T_HUGE = 4

/** Characters of T_BODY text that fit across a panel from `x`. */
const fits = (x: number, scale = T_BODY) => Math.floor((W - PAD - x + scale) / (ADVANCE * scale))

/** A dark arcade panel with a chunky pixel border and a title row. */
const panel = (p: Pix, y: number, h: number, accent: string, title?: string, right?: string) => {
  let out = `<rect x="0" y="${y}" width="${W}" height="${h}" fill="${PANEL}"/>
   <path fill="${accent}" d="M3 ${y}h${W - 6}v3h-${W - 6}zM3 ${y + h - 3}h${W - 6}v3h-${W - 6}zM0 ${y + 3}h3v${h - 6}h-3zM${W - 3} ${y + 3}h3v${h - 6}h-3z"/>`
  if (title) out += p.text(title, PAD, y + PAD, T_BIG, accent)
  if (right) out += p.text(right, W - PAD - textWidth(right, T_BODY), y + PAD + 3, T_BODY, CREAM)
  return out
}

/** A segmented bar; a null `pct` sweeps a lit block back and forth. */
const segBar = (x: number, y: number, w: number, h: number, segs: number, pct: number | null, color: string) => {
  const gap = 2
  const sw = (w - gap * (segs - 1)) / segs
  const lit = pct === null ? 0 : Math.round(Math.min(1, Math.max(0, pct)) * segs)
  let out = `<rect x="${x - 2}" y="${y - 2}" width="${w + 4}" height="${h + 4}" fill="${INK}"/>`
  for (let i = 0; i < segs; i++) {
    const sx = (x + i * (sw + gap)).toFixed(1)
    const isLit = i < lit
    out += `<rect x="${sx}" y="${y}" width="${sw.toFixed(1)}" height="${h}" fill="${isLit ? color : PANEL_HI}"/>`
    if (isLit) out += `<rect x="${sx}" y="${y}" width="${sw.toFixed(1)}" height="3" fill="#FFFFFF" fill-opacity=".3"/>`
  }
  if (pct === null) {
    const bw = sw * 3 + gap * 2
    out += `<rect x="${x}" y="${y}" width="${bw.toFixed(1)}" height="${h}" fill="${color}"><animate attributeName="x" values="${x};${(x + w - bw).toFixed(1)};${x}" dur="2.4s" repeatCount="indefinite"/></rect>`
  }
  return out
}

const limitName = (kind: string) =>
  kind === 'five_hour' ? 'SESSION' : kind === 'seven_day' ? 'WEEK' : kind === 'spend_limit' ? 'SPEND' : kind.replace(/_/g, ' ')

const meterColor = (pct: number) => (pct >= 90 ? BAD : pct >= 70 ? WARN : GOOD)

/** Text broken into at most `lines` lines of `perLine` characters. */
const wrap = (text: string, perLine: number, lines: number) => {
  const words = normText(text).replace(/\s+/g, ' ').trim().split(' ')
  const out: string[] = []
  let line = ''
  let used = 0
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= perLine) {
      line = next
      used++
      continue
    }
    if (line) out.push(line)
    if (out.length === lines) break
    line = word.slice(0, perLine)
    used++
  }
  if (out.length < lines && line) out.push(line)
  if (used < words.length || out.join(' ').length < words.join(' ').length) {
    out[out.length - 1] = clip(`${out[out.length - 1]!}…`.slice(0, perLine + 1), perLine)
  }
  return out
}

type SceneState = {
  status: Status | 'idle'
  pct: number | null
  title: string
  prompt: string
  limits: Limit[]
  sessionUsd: number
  now: number
}

/**
 * The top screen, animated: the usage meters as a game's energy bars, then
 * the play area where the mascot walks the task's progress track to the flag.
 * It holds no ticking clock, so it redraws only when progress or usage moves.
 */
const topScreen = (s: SceneState) => {
  const p = new Pix()
  let body = ''
  let y = 0

  // Energy bars: the plan's usage windows and the session's spend.
  const meterH = 44
  const uh = 42 + Math.max(1, s.limits.length) * meterH
  body += panel(p, y, uh, CORAL, 'USAGE', `SPEND ${fmtUsd(s.sessionUsd)}`)
  body += p.sprite('heart', ['.x.x.', 'xxxxx', 'xxxxx', '.xxx.', '..x..'], { x: CORAL }, PAD + textWidth('USAGE', T_BIG) + 8, y + PAD + 2, 3)
  if (s.limits.length === 0) {
    body += p.text('NO PLAN LIMITS YET', PAD, y + 48, T_BODY, MUTED)
  }
  s.limits.forEach((l, i) => {
    const ry = y + 44 + i * meterH
    const pct = Math.max(0, l.percentUsed)
    const color = meterColor(pct)
    const resetMs = l.resetsAt ? Date.parse(l.resetsAt) - s.now : NaN
    const pctText = `${Math.round(pct)}%`
    body += p.text(limitName(l.kind), PAD, ry, T_BODY, CREAM)
    body += p.text(pctText, PAD + textWidth(limitName(l.kind), T_BODY) + 10, ry, T_BODY, color)
    if (Number.isFinite(resetMs)) {
      const reset = `IN ${fmtIn(resetMs)}`
      body += p.text(reset, W - PAD - textWidth(reset, T_BODY), ry, T_BODY, MUTED)
    }
    body += segBar(PAD + 2, ry + 21, W - 2 * PAD - 4, 12, 16, pct / 100, color)
  })
  y += uh + GAP

  // Play area.
  const promptLines = wrap(s.prompt, fits(PAD), 2)
  const H = 64 + promptLines.length * 20 + 76
  const accent = s.status === 'error' ? BAD : s.status === 'stopped' ? MUTED : CORAL
  body += panel(p, y, H, accent)
  body += p.text(clip(s.title, 12), PAD, y + PAD + 2, T_BIG, accent)
  const pctText = s.status === 'idle' ? '' : s.pct === null ? '...' : `${Math.round(s.pct * 100)}%`
  if (pctText) body += p.text(pctText, W - PAD - textWidth(pctText, T_BIG), y + PAD + 2, T_BIG, CREAM)
  promptLines.forEach((line, i) => {
    body += p.text(line, PAD, y + 48 + i * 20, T_BODY, MUTED)
  })

  const S = 4
  const trackX = PAD + 4
  const trackW = W - 2 * trackX
  const trackY = y + H - 28
  const mw = 16 * S
  const groundY = trackY - 9 * S - 6
  const stars: [number, number][] = [[24, -50], [92, -66], [170, -46], [236, -62], [300, -40], [130, -30]]
  body += stars.map(([sx, sy], i) => p.sparkle(sx, groundY + sy + 30, 2, i % 2 ? CREAM : CORAL_HI, i * 0.35)).join('')
  if (s.status === 'idle') {
    const x = (W - mw) / 2
    body += `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 ${S};0 0" dur="2s" calcMode="discrete" repeatCount="indefinite"/>${p.mascot('sleep', x, groundY, S)}</g>`
    body += [0, 1, 2]
      .map(i => `<g opacity="0">${p.text('z', x + mw + 6 + i * 12, groundY - 2 - i * 11, 1 + i, CREAM)}<animate attributeName="opacity" values="0;1;1;0" dur="2.4s" begin="${i * 0.6}s" repeatCount="indefinite"/></g>`)
      .join('')
  } else {
    body += p.sprite('flag', ['f...', 'ffff', 'fff.', 'ff..', 'f...', 'f...', 'f...', 'f...'], { f: CREAM }, trackX + trackW - 12, trackY - 38, 4)
    const span = trackW - mw - 20
    if (s.status === 'running' && s.pct === null) {
      body += `<g>${p.walker(trackX, groundY, S)}<animateTransform attributeName="transform" type="translate" values="0 0;${span} 0;0 0" dur="6s" repeatCount="indefinite" additive="sum"/></g>`
    } else if (s.status === 'running') {
      body += p.walker(trackX + (s.pct ?? 0) * span, groundY, S)
    } else {
      const x = trackX + span
      if (s.status === 'done') {
        body += `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -${S * 3};0 0;0 0" dur="1s" calcMode="discrete" repeatCount="indefinite"/>${p.mascot('happy', x, groundY, S)}</g>`
        body += p.sparkle(x - 22, groundY - 12, 4, CORAL_HI, 0) + p.sparkle(x - 48, groundY + 8, 3, GOOD, 0.8)
      } else {
        body += p.mascot('sad', x, groundY, S)
      }
    }
  }
  body += segBar(trackX, trackY, trackW, 14, 16, s.status === 'idle' ? 0 : s.pct, accent)
  y += H

  return { source: p.svg(W, y, body), height: y }
}

type BottomState = {
  stats: { label: string; value: string; tip: string }[]
  plan?: Plan
  agents: { a: SubAgent; time: string; detail: string }[]
  frame: number
}

/**
 * The lower screen, redrawn every second: stats, the quest log and the party.
 * Animation here comes from those redraws (the second's parity), not SMIL.
 */
const bottomScreen = (s: BottomState) => {
  const p = new Pix()
  let body = ''
  let y = 0

  // Stats: a 2 by 3 grid of pixel boxes.
  const cols = 2
  const bw = (W - GAP) / cols
  const bh = 64
  s.stats.forEach((st, i) => {
    const x = (i % cols) * (bw + GAP)
    const by = y + Math.floor(i / cols) * (bh + GAP)
    const scale = textWidth(st.value, T_HUGE) <= bw - 24 ? T_HUGE : T_BIG
    body += `<g><title>${esc(st.tip)}</title><rect x="${x}" y="${by}" width="${bw}" height="${bh}" fill="${PANEL}"/>
      <path fill="${PANEL_HI}" d="M${x} ${by}h${bw}v3h-${bw}zM${x} ${by + bh - 3}h${bw}v3h-${bw}zM${x} ${by}h3v${bh}h-3zM${x + bw - 3} ${by}h3v${bh}h-3z"/>
      <rect x="${x + 3}" y="${by + 3}" width="6" height="6" fill="${CORAL}"/>
      ${p.text(st.label, x + 14, by + 12, T_BODY, MUTED)}${p.text(st.value, x + 14, by + 30 + (T_HUGE - scale) * 4, scale, CREAM)}</g>`
  })
  y += Math.ceil(s.stats.length / cols) * (bh + GAP)

  // Quest log: the task list, each item wrapping to two lines.
  if (s.plan && s.plan.items.length > 0) {
    const items = s.plan.items.slice(0, 10)
    const done = s.plan.items.filter(i => i.status === 'completed').length
    const textX = PAD + 24
    const rows = items.map(item => wrap(item.content, fits(textX), 2))
    const h = 46 + rows.reduce((n, r) => n + r.length * 20 + 6, 0)
    body += panel(p, y, h, CORAL, 'QUESTS', `${done}/${s.plan.items.length}`)
    let iy = y + 46
    items.forEach((item, i) => {
      const color = item.status === 'completed' ? MUTED : item.status === 'in_progress' ? CORAL : CREAM
      if (item.status === 'completed') {
        body += p.sprite('chk', ['xxxxx', 'x...c', 'xc.cx', 'x.c.x', 'xxxxx'], { x: MUTED, c: GOOD }, PAD, iy, 3)
      } else if (item.status === 'in_progress') {
        body += p.sprite(s.frame % 2 ? 'cur-b' : 'cur-a', ['x...', 'xx..', 'xxx.', 'xx..', 'x...'], { x: s.frame % 2 ? CORAL_HI : CORAL }, PAD, iy, 3)
      } else {
        body += p.sprite('box', ['xxxxx', 'x...x', 'x...x', 'x...x', 'xxxxx'], { x: PANEL_HI }, PAD, iy, 3)
      }
      rows[i]!.forEach((line, li) => {
        body += p.text(line, textX, iy + li * 20, T_BODY, color)
      })
      iy += rows[i]!.length * 20 + 6
    })
    y += h + GAP
  }

  // Party: the subagents.
  if (s.agents.length > 0) {
    const shown = s.agents.slice(-6)
    const rowH = 100
    const h = 44 + shown.length * rowH
    const running = s.agents.filter(x => x.a.status === 'running').length
    body += panel(p, y, h, CORAL, 'PARTY', `${running} ACTIVE`)
    shown.forEach(({ a, time, detail }, i) => {
      const ry = y + 44 + i * rowH
      const isRunning = a.status === 'running'
      const accent = a.status === 'error' ? BAD : a.status === 'stopped' ? MUTED : CORAL
      const mood: Mood = isRunning ? (s.frame % 2 ? 'walkB' : 'walkA') : a.status === 'done' ? 'happy' : 'sad'
      const badge = isRunning ? 'RUN' : a.status === 'done' ? 'DONE' : a.status === 'stopped' ? 'STOP' : 'ERR'
      const badgeColor = isRunning ? CORAL : a.status === 'done' ? GOOD : BAD
      const textX = PAD + 58
      const bdw = textWidth(badge, T_BODY) + 10
      body += `<rect x="8" y="${ry}" width="${W - 16}" height="${rowH - 8}" fill="${INK}" fill-opacity=".6"/>`
      body += p.mascot(mood, PAD, ry + 12 - (isRunning && s.frame % 2 ? 3 : 0), 3)
      body += p.text(clip(a.description, fits(textX)), textX, ry + 8, T_BODY, CREAM)
      body += `<rect x="${textX}" y="${ry + 28}" width="${bdw}" height="19" fill="${badgeColor}"/>`
      body += p.text(badge, textX + 5, ry + 30, T_BODY, INK)
      body += p.text(time, textX + bdw + 10, ry + 30, T_BODY, CREAM)
      body += p.text(clip(detail, fits(textX)), textX, ry + 54, T_BODY, MUTED)
      const lit = isRunning ? ((s.frame % 8) + 1) / 9 : 1
      body += segBar(textX, ry + 76, W - textX - PAD - 4, 10, 12, lit, accent)
    })
    y += h + GAP
  }

  return { source: p.svg(W, y - GAP, body), height: y - GAP }
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
      description: 'Show the Pixel HUD: task progress, usage limits, quests and subagents',
    })
    void $.ui.open({ id: PANE, title: 'Pixel HUD' })
    const started = await next(e)
    await update($, nowAtom, () => Date.now())
    await refreshUsage($)
    return started
  })

  on('command.run', { command: 'progress' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Pixel HUD' })
    await refreshUsage($)
    return { text: 'Pixel HUD opened.' }
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
        // The desktop app's wrap-up checks off the whole task list.
        const isWrapUp = name.endsWith('__wrap_up')
        const plan = isPlan
          ? applyPlanCall(run.plan, args)
          : isWrapUp && run.plan
            ? { items: run.plan.items.map(i => ({ ...i, status: 'completed' as const })) }
            : run.plan
        return { ...run, tools: run.tools + 1, lastTool: isPlan || isWrapUp ? run.lastTool : name, plan }
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

    const status: Status | 'idle' = run?.status ?? 'idle'
    const pct = run ? progressOf(run, agents) : 0
    const title = !run
      ? 'READY'
      : run.status === 'running'
        ? 'WORKING'
        : run.status === 'done'
          ? 'TASK CLEAR!'
          : run.status === 'stopped'
            ? 'STOPPED'
            : 'GAME OVER'
    const prompt = run ? run.prompt || '(continuing)' : 'Send a prompt to start a quest'
    const elapsed = run ? (run.endedAt ?? now) - run.startedAt : 0
    const runCost = run ? Math.max(0, costUsd - run.costAtStart) : 0
    const mainTokens = run?.tokens ?? zero()
    const allTokens = agents.reduce((n, a) => n + totalTokens(a.tokens), totalTokens(mainTokens))
    const allWeight = agents.reduce((n, a) => n + weight(a.tokens), weight(mainTokens)) || 1
    const stats = [
      { label: 'TIME', value: fmtTime(elapsed), tip: 'Time this task has taken' },
      { label: 'COST', value: fmtUsd(runCost), tip: "This task's real spend: the session's cost since the prompt" },
      {
        label: 'TOKENS',
        value: fmtTokens(allTokens),
        tip: `Main: in ${fmtTokens(mainTokens.input)}, out ${fmtTokens(mainTokens.output)}, cache read ${fmtTokens(mainTokens.cacheRead)}, cache write ${fmtTokens(mainTokens.cacheWrite)}; subagents included in the total`,
      },
      { label: 'STEPS', value: String(run?.steps ?? 0), tip: 'Model calls in this task' },
      { label: 'TOOLS', value: String(run?.tools ?? 0), tip: 'Tool calls in this task' },
      { label: 'AGENTS', value: String(agents.length), tip: 'Subagents this task started' },
    ]
    const party = agents.map(a => {
      const aCost = runCost * (weight(a.tokens) / allWeight)
      const aTime = (a.endedAt ?? now) - a.startedAt
      return {
        a,
        time: fmtTime(aTime),
        detail: `${fmtTokens(totalTokens(a.tokens))} TOK · ~${fmtUsd(aCost)}`,
      }
    })

    if (Svg) {
      const top = topScreen({ status, pct, title, prompt, limits, sessionUsd: costUsd, now: Math.floor(now / 60000) * 60000 })
      const bottom = run ? bottomScreen({ stats, plan: run.plan, agents: party, frame }) : undefined
      return (
        <Box flexDirection="column" padding={1} gap={1}>
          <Svg
            source={top.source}
            width={W}
            height={top.height}
            isInteractive
            alt={`${title}${pct === null ? '' : ` ${Math.round((pct ?? 0) * 100)}%`}. Usage: session spend ${fmtUsd(costUsd)}; ${limits.map(l => `${limitName(l.kind)} ${Math.round(l.percentUsed)}%`).join(', ') || 'no plan limits reported'}`}
          />
          {bottom && (
            <Svg
              source={bottom.source}
              width={W}
              height={bottom.height}
              alt={`${stats.map(s => `${s.label} ${s.value}`).join(', ')}${party.length ? `. Subagents: ${party.map(x => `${x.a.description} ${x.a.status}`).join(', ')}` : ''}`}
            />
          )}
        </Box>
      )
    }

    // The terminal: the same screen in block characters, in the same order.
    const width = Math.max(10, Math.min(40, (e.viewport?.columns ?? 50) - 14))
    const isRunning = status === 'running'
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text color="claude" weight="bold">♥ USAGE · spend {fmtUsd(costUsd)}</Text>
          {limits.length === 0 && <Text dimColor>No plan limits reported yet.</Text>}
          {limits.map(l => {
            const resetMs = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN
            return (
              <Text>
                {limitName(l.kind).padEnd(8)}
                <Text color={l.percentUsed >= 90 ? 'error' : l.percentUsed >= 70 ? 'warning' : 'success'}>{textBar(l.percentUsed / 100, Math.min(20, width), 0)}</Text> {Math.round(l.percentUsed)}%
                {Number.isFinite(resetMs) ? <Text dimColor> · {fmtIn(resetMs).toLowerCase()}</Text> : ''}
              </Text>
            )
          })}
        </Box>

        <Box flexDirection="row" gap={2} alignItems="center">
          <Box flexDirection="column">
            {(isRunning && frame % 2 ? TERM_MASCOT_STEP : TERM_MASCOT).map(line => (
              <Text color="claude">{line}</Text>
            ))}
          </Box>
          <Box flexDirection="column">
            <Text color="claude" weight="bold">
              {isRunning ? SPARK_FRAMES[frame % SPARK_FRAMES.length] : '✻'} {title}
              {run && pct !== null ? ` ${Math.round(pct * 100)}%` : ''}
            </Text>
            <Text color="claude">{textBar(status === 'idle' ? 0 : pct, width, frame)}</Text>
            <Text dimColor>{clip(prompt, 60)}</Text>
          </Box>
        </Box>

        {run && (
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {stats.map(s => (
              <Box flexDirection="column" minWidth={8}>
                <Text dimColor>{s.label}</Text>
                <Text weight="semibold">{s.value}</Text>
              </Box>
            ))}
          </Box>
        )}

        {run?.plan && run.plan.items.length > 0 && (
          <Box flexDirection="column">
            <Text color="claude" weight="bold">QUEST LOG</Text>
            {run.plan.items.map(i => (
              <Text dimColor={i.status === 'completed'} color={i.status === 'in_progress' ? 'claude' : undefined}>
                {i.status === 'completed' ? '■' : i.status === 'in_progress' ? '▶' : '□'} {clip(i.content, 70)}
              </Text>
            ))}
          </Box>
        )}

        {party.length > 0 && (
          <Box flexDirection="column">
            <Text color="claude" weight="bold">PARTY</Text>
            {party.map(({ a, time, detail }) => (
              <Box key={a.key} flexDirection="column">
                <Text weight="semibold">
                  {a.status === 'running' ? SPARK_FRAMES[frame % SPARK_FRAMES.length] : a.status === 'done' ? '✓' : '✗'} {clip(a.description, 50)}
                </Text>
                <Text dimColor>{`${a.type} · ${time} · ${detail.toLowerCase()}`}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
