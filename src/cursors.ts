// Cursores remotos y fichas sincronizadas con ellos.
//
// Supabase Realtime cuenta cada mensaje enviado y cada mensaje entregado, y si el proyecto pasa de su
// cupo por segundo (100 en el plan Free) desconecta a los clientes: los cursores se congelan y la
// presencia se pierde. Por eso cada jugador no manda un mensaje por movimiento, sino un paquete cada
// SEND_INTERVAL_MS con todas las posiciones muestreadas desde el anterior. Quien lo recibe reproduce
// esas posiciones con un retraso fijo (PLAYBACK_DELAY_MS), interpolando entre ellas: el recorrido sale
// idéntico al real y fluido, a cambio de un pequeño retraso. Los clics en fichas viajan en el mismo
// paquete y se aplican en el mismo instante de la reproducción, así la ficha baja justo cuando el
// cursor remoto hace clic.

// Si el proyecto está en un plan con más cupo (Pro: 500 msg/s) se puede bajar a ~60 ms (el retraso baja con él).
export const SEND_INTERVAL_MS = 150
const SAMPLE_INTERVAL_MS = 16
// Margen para la latencia irregular de la red además del intervalo de envío.
export const PLAYBACK_DELAY_MS = SEND_INTERVAL_MS + 140
// Suavizado final, solo para disimular los saltos cuando un paquete llega tarde.
const OUTPUT_SMOOTHING_MS = 22
// Separación mínima entre paquetes cuando un clic obliga a enviar antes de tiempo.
const URGENT_MIN_GAP_MS = 60
const SCALE = 10000
// Ventana de paquetes con la que se estima la diferencia de reloj + latencia mínima de cada emisor.
const OFFSET_WINDOW = 40
const OFFSET_SLEW = 0.08

export const CURSOR_HOTSPOT = 4

// Paquete de cursor: `t` es la hora (Date.now del emisor) de la primera muestra, `w` cuánto después de
// `t` se envió, `p` las muestras [dt, x, y, pulsado] y `f` los clics en fichas [dt, personaje, bajada].
export type CursorPacket = {
  u: string
  s: number
  n: string
  t: number
  w: number
  p: number[]
  f?: [number, string, number][]
}

// Las coordenadas se envían relativas al tablero (pueden salirse de 0..1 fuera de él): cada pantalla
// y la vista OBS tienen proporciones distintas y así el cursor cae sobre la misma ficha en todas.
let boardElement: HTMLElement | null = null
let boardRectCache: { left: number; top: number; width: number; height: number } | null = null
let boardObserver: ResizeObserver | null = null
const invalidateBoardRect = () => {
  boardRectCache = null
}
window.addEventListener('resize', invalidateBoardRect)
window.addEventListener('scroll', invalidateBoardRect, true)

export function setBoardElement(element: HTMLElement | null) {
  boardObserver?.disconnect()
  boardObserver = null
  boardElement = element
  boardRectCache = null
  if (element && typeof ResizeObserver !== 'undefined') {
    boardObserver = new ResizeObserver(invalidateBoardRect)
    boardObserver.observe(element)
  }
}

function boardRect() {
  if (!boardRectCache) {
    const rect = boardElement?.getBoundingClientRect()
    boardRectCache = rect && rect.width > 0 && rect.height > 0
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  }
  return boardRectCache
}

export class CursorSender {
  private samples: number[] = []
  private flips: [number, string, number][] = []
  private base = 0
  private lastSampleAt = -Infinity
  private lastFlushAt = -Infinity
  private timer = 0
  private last: { x: number; y: number; d: number } | null = null

  constructor(
    private readonly send: (packet: CursorPacket) => void,
    private readonly meta: { userId: string; slot: number; name: string },
  ) {}

  sample(clientX: number, clientY: number, down: boolean, urgent = false) {
    const rect = boardRect()
    const point = {
      x: Math.round(((clientX - rect.left) / rect.width) * SCALE),
      y: Math.round(((clientY - rect.top) / rect.height) * SCALE),
      d: down ? 1 : 0,
    }
    const now = Date.now()
    const changedDown = point.d !== this.last?.d
    this.last = point
    if (!urgent && !changedDown && now - this.lastSampleAt < SAMPLE_INTERVAL_MS) return
    this.lastSampleAt = now
    this.push(now, point)
    this.schedule(urgent || changedDown)
  }

  flip(character: string, down: boolean) {
    const now = Date.now()
    if (!this.samples.length && !this.flips.length) this.base = now
    this.flips.push([now - this.base, character, down ? 1 : 0])
    this.schedule(true)
  }

  // Vuelve a anunciar la última posición (al conectarse o reconectarse el canal).
  resend() {
    if (!this.last) return
    this.push(Date.now(), this.last)
    this.schedule(true)
  }

  dispose() {
    window.clearTimeout(this.timer)
    this.timer = 0
  }

  private push(now: number, point: { x: number; y: number; d: number }) {
    if (!this.samples.length && !this.flips.length) this.base = now
    this.samples.push(now - this.base, point.x, point.y, point.d)
  }

  private schedule(urgent: boolean) {
    const gap = urgent ? URGENT_MIN_GAP_MS : SEND_INTERVAL_MS
    const wait = Math.max(0, this.lastFlushAt + gap - Date.now())
    if (this.timer) {
      if (!urgent) return
      window.clearTimeout(this.timer)
    }
    this.timer = window.setTimeout(this.flush, wait)
  }

  private flush = () => {
    this.timer = 0
    if (!this.samples.length && !this.flips.length) return
    const now = Date.now()
    this.lastFlushAt = now
    const packet: CursorPacket = {
      u: this.meta.userId,
      s: this.meta.slot,
      n: this.meta.name,
      t: this.base,
      w: now - this.base,
      p: this.samples,
    }
    if (this.flips.length) packet.f = this.flips
    this.samples = []
    this.flips = []
    this.send(packet)
  }
}

type Sample = { t: number; x: number; y: number; d: number }

type RemoteTrack = {
  samples: Sample[]
  offsets: number[]
  // Desfase objetivo (mínimo de la ventana) y el aplicado, que lo sigue poco a poco.
  targetOffset: number
  offset: number
  element: HTMLElement | null
  fallback: { x: number; y: number }
  px: number
  py: number
  placed: boolean
  down: boolean
  drawn: string
}

export type CursorHandlers = {
  // Llega un paquete de alguien a quien aún no se está dibujando (p. ej. si su presencia no llegó).
  onUser?: (userId: string, slot: number, name: string) => void
  // Clic en ficha de un compañero, a aplicar en `applyAt` (Date.now local).
  onFlip?: (character: string, down: boolean, applyAt: number) => void
}

export class CursorReceiver {
  handlers: CursorHandlers = {}
  private tracks = new Map<string, RemoteTrack>()
  private known = new Map<string, string>()
  private frame = 0
  private lastFrame = 0

  private track(userId: string) {
    let track = this.tracks.get(userId)
    if (!track) {
      track = { samples: [], offsets: [], targetOffset: 0, offset: 0, element: null, fallback: { x: 0, y: 0 }, px: 0, py: 0, placed: false, down: false, drawn: '' }
      this.tracks.set(userId, track)
    }
    return track
  }

  receive(packet: CursorPacket) {
    if (!packet?.u || !Array.isArray(packet.p)) return
    const now = Date.now()
    const track = this.track(packet.u)

    // Diferencia entre el reloj del emisor y el local más la latencia mínima reciente.
    track.offsets.push(now - (packet.t + packet.w))
    if (track.offsets.length > OFFSET_WINDOW) track.offsets.shift()
    track.targetOffset = Math.min(...track.offsets)
    // Primer paquete o salto de reloj: se aplica de golpe. Si no, draw() lo acerca sin acelerones.
    if (track.offsets.length === 1 || Math.abs(track.targetOffset - track.offset) > 1000) track.offset = track.targetOffset

    const p = packet.p
    for (let i = 0; i + 3 < p.length; i += 4) {
      const t = packet.t + p[i]
      const last = track.samples[track.samples.length - 1]
      if (last && t < last.t) continue
      track.samples.push({ t, x: p[i + 1] / SCALE, y: p[i + 2] / SCALE, d: p[i + 3] })
    }
    // Sin pestaña visible no hay fotogramas que recorten el búfer: se recorta aquí.
    const keepFrom = now - track.offset - PLAYBACK_DELAY_MS - 1000
    while (track.samples.length > 2 && track.samples[1].t < keepFrom) track.samples.shift()

    for (const [dt, character, down] of packet.f ?? []) {
      this.handlers.onFlip?.(character, down === 1, packet.t + dt + track.offset + PLAYBACK_DELAY_MS)
    }

    const meta = `${packet.s}|${packet.n}`
    if (this.known.get(packet.u) !== meta) {
      this.known.set(packet.u, meta)
      this.handlers.onUser?.(packet.u, packet.s, packet.n)
    }
  }

  attach(userId: string, element: HTMLElement, fallback: { x: number; y: number }) {
    const track = this.track(userId)
    track.element = element
    track.fallback = fallback
    track.placed = false
    track.down = false
    track.drawn = ''
    this.draw(track, Date.now(), 0)
    this.start()
    return () => {
      if (track.element === element) track.element = null
      this.stopIfIdle()
    }
  }

  // Olvida a un jugador que se ha ido: si vuelve, se avisa otra vez con onUser.
  forget(userId: string) {
    this.known.delete(userId)
  }

  // Al cambiar de sala: se descartan las muestras pero se conservan los cursores ya montados.
  reset() {
    this.known.clear()
    for (const [userId, track] of this.tracks) {
      if (!track.element) {
        this.tracks.delete(userId)
        continue
      }
      track.samples = []
      track.offsets = []
      track.placed = false
    }
  }

  private start() {
    if (this.frame) return
    this.lastFrame = performance.now()
    this.frame = window.requestAnimationFrame(this.tick)
  }

  private stopIfIdle() {
    for (const track of this.tracks.values()) if (track.element) return
    window.cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  private tick = (frameTime: number) => {
    const elapsed = Math.min(100, frameTime - this.lastFrame)
    this.lastFrame = frameTime
    const now = Date.now()
    for (const track of this.tracks.values()) if (track.element) this.draw(track, now, elapsed)
    this.frame = window.requestAnimationFrame(this.tick)
  }

  private draw(track: RemoteTrack, now: number, elapsed: number) {
    const element = track.element
    if (!element) return
    let targetX: number
    let targetY: number
    let down = track.down
    const samples = track.samples

    if (elapsed > 0 && track.offset !== track.targetOffset) {
      // Como mucho un 8 % más rápido o más lento que el tiempo real: el ajuste no se nota.
      const maxStep = elapsed * OFFSET_SLEW
      track.offset += Math.max(-maxStep, Math.min(maxStep, track.targetOffset - track.offset))
    }

    if (!samples.length) {
      targetX = track.fallback.x * window.innerWidth
      targetY = track.fallback.y * window.innerHeight
    } else {
      const playAt = now - track.offset - PLAYBACK_DELAY_MS
      while (samples.length > 2 && samples[1].t <= playAt) samples.shift()
      let x: number
      let y: number
      const [a, b] = samples
      if (!b || playAt <= a.t) {
        // Antes de la primera muestra o después de la última: se queda quieto en ella.
        x = a.x
        y = a.y
        down = a.d === 1
      } else if (playAt >= b.t) {
        x = b.x
        y = b.y
        down = b.d === 1
      } else {
        const k = (playAt - a.t) / (b.t - a.t)
        x = a.x + (b.x - a.x) * k
        y = a.y + (b.y - a.y) * k
        down = a.d === 1
      }
      const rect = boardRect()
      targetX = rect.left + x * rect.width
      targetY = rect.top + y * rect.height
    }

    if (!track.placed || elapsed === 0) {
      track.px = targetX
      track.py = targetY
      track.placed = true
    } else {
      const blend = 1 - Math.exp(-elapsed / OUTPUT_SMOOTHING_MS)
      track.px += (targetX - track.px) * blend
      track.py += (targetY - track.py) * blend
    }

    const transform = `translate3d(${(track.px - CURSOR_HOTSPOT).toFixed(1)}px, ${(track.py - CURSOR_HOTSPOT).toFixed(1)}px, 0)`
    if (transform !== track.drawn) {
      element.style.transform = transform
      track.drawn = transform
    }
    if (down !== track.down) {
      track.down = down
      // Atributo y no clase: React reescribe className si se vuelve a pintar el cursor.
      element.toggleAttribute('data-down', down)
    }
  }
}
