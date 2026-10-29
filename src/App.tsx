import { CSSProperties, FormEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { ensureAnonymousSession, isSupabaseConfigured, leaveRoomOnUnload, supabase } from './supabase'
import { CURSOR_HOTSPOT, CursorReceiver, CursorSender, setBoardElement } from './cursors'
import type { CursorPacket } from './cursors'
import {
  chooseTeamCharacter,
  createRoom,
  getPlayers,
  getRoomByCode,
  getTeamBoard,
  getTeamMessages,
  getRoomAvailability,
  joinTeam,
  leaveRoom as leaveRoomRpc,
  resetTeamBoard,
  sendMessage,
  shuffle,
  spectateTeam,
  syncRoom,
  toggleCard,
} from './game'
import type { RoomOccupant, RosterPlayer } from './game'
import type { ChatMessage, Player, Room, Slot, Team, TeamBoard } from './types'

const TEAM_NAMES: Record<Team, string> = { 1: 'Equipo Azul', 2: 'Equipo Rojo' }
const TEAM_COLORS: Record<Team, string> = { 1: 'blue', 2: 'red' }
const SLOTS: Slot[] = [1, 2, 3, 4]

// La sala se maqueta sobre un lienzo fijo de 1920×1080 que se escala entero a la ventana (con bandas si
// no es 16:9): así las cámaras caen siempre en los mismos píxeles del vídeo.
const STAGE_WIDTH = 1920
const STAGE_HEIGHT = 1080

function characterImage(character: string) {
  return `${import.meta.env.BASE_URL}characters/${encodeURIComponent(character)}.png`
}

// Vista OBS (?obs=<clave del equipo>): espectador de solo lectura, sin puesto, presencia ni cursor propio.
const OBS_KEY = new URLSearchParams(window.location.search).get('obs')?.trim() ?? ''
const SPECTATING = Boolean(OBS_KEY)
// Fondo de página transparente para que OBS muestre las cámaras por detrás (ver .obs-mode en styles.css).
if (SPECTATING) document.documentElement.classList.add('obs-mode')

function obsLink(key: string) {
  return `${window.location.origin}${window.location.pathname}?obs=${encodeURIComponent(key)}`
}
const CURSOR_ANCHORS: Record<Slot, { x: number; y: number }> = {
  1: { x: 0.12, y: 0.34 },
  2: { x: 0.18, y: 0.62 },
  3: { x: 0.82, y: 0.34 },
  4: { x: 0.88, y: 0.62 },
}

// El mismo cursor para los cuatro jugadores. El PNG está al doble de tamaño para pantallas de alta densidad.
const CURSOR_FILE = `${import.meta.env.BASE_URL}cursors/cursor.png`

// Tamaño con el que se dibuja el cursor (ver .remote-cursor en styles.css).
const CURSOR_WIDTH = 29
const CURSOR_HEIGHT = 48
const OWN_LABEL_OFFSET = { x: 26, y: 38 }

// El cursor nativo se dibuja al tamaño del PNG, así que se reduce en un canvas al tamaño en pantalla.
function scaleCursor(src: string) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = CURSOR_WIDTH
      canvas.height = CURSOR_HEIGHT
      const context = canvas.getContext('2d')
      if (!context) return reject(new Error('Canvas no disponible'))
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, 0, 0, CURSOR_WIDTH, CURSOR_HEIGHT)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = reject
    image.src = src
  })
}

function useScaledCursor(enabled: boolean) {
  const [cursor, setCursor] = useState<string | null>(null)

  useEffect(() => {
    setCursor(null)
    if (!enabled) return
    let alive = true
    scaleCursor(CURSOR_FILE)
      .then((url) => {
        if (alive) setCursor(url)
      })
      .catch(() => {
        // Si la imagen no carga se queda el cursor normal del sistema.
      })
    return () => {
      alive = false
    }
  }, [enabled])

  return cursor
}

function cursorCss(dataUrl: string) {
  return `url("${dataUrl}") ${CURSOR_HOTSPOT} ${CURSOR_HOTSPOT}, auto`
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  // Los errores de Supabase (PostgrestError) son objetos planos con `message`, no instancias de Error.
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

const CHAT_MUTED_KEY = 'oqeq-chat-muted'

function readChatMuted() {
  try {
    return window.localStorage.getItem(CHAT_MUTED_KEY) === '1'
  } catch {
    return false
  }
}

let audioContext: AudioContext | null = null

// "Ding" corto de dos notas generado con Web Audio, sin archivos de sonido.
function playChatSound() {
  try {
    audioContext ??= new AudioContext()
    const ctx = audioContext
    if (ctx.state === 'suspended') void ctx.resume()
    const start = ctx.currentTime
    for (const [offset, frequency] of [[0, 880], [0.09, 1320]] as const) {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start + offset)
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22)
      oscillator.connect(gain).connect(ctx.destination)
      oscillator.start(start + offset)
      oscillator.stop(start + offset + 0.24)
    }
  } catch {
    // Sin soporte de audio: se ignora.
  }
}

type SystemVariant = 'self' | 'join' | 'leave' | 'info'

type ChatEntry =
  | ({ kind: 'chat' } & ChatMessage)
  | { kind: 'system'; id: string; variant: SystemVariant; text: string; created_at: string }

// Recuento de fichas bajadas de un equipo; `v` es la versión del tablero para quedarse con el último.
type BoardCount = { team: Team; down: number; v?: number }

type BoardUpdate = { flipped: string[]; version?: number; reset?: boolean }

type RemotePlayer = { userId: string; slot: Slot; name: string }

// Héroe marcado en la ventana de elegir personaje antes de confirmarlo. Es uno por equipo: viaja por el
// canal del equipo y gana el de `at` más alto (y `by` para desempatar), así los dos acaban con el mismo.
type TeamPick = { character: string; at: number; by: string }

function isNewerPick(incoming: TeamPick, current: TeamPick | null) {
  return !current || incoming.at > current.at || (incoming.at === current.at && incoming.by > current.by)
}

// Ficha cambiada en local o por un compañero antes de que llegue el tablero confirmado.
// Hasta `applyAt` se ve como estaba; de ahí a `until` en el estado nuevo; después manda el servidor.
type FlipOverride = { down: boolean; applyAt: number; until: number }
const FLIP_HOLD_MS = 2500

// Latido (room_sync): marca al jugador como activo y trae jugadores, tablero y último mensaje.
// La vista OBS solo lee, y si la sala está vacía consulta mucho menos (la presencia la avisa al entrar alguien).
const SYNC_PLAYER_MS = 10_000
const SYNC_OBS_MS = 15_000
const SYNC_OBS_EMPTY_MS = 60_000

// Puesto de esta pestaña, para volver a entrar solo al recargar (al cerrar o recargar se libera).
const SEAT_KEY = 'oqeq-seat'
type Seat = { code: string; team: Team; name: string }

function readSeat(): Seat | null {
  try {
    const seat = JSON.parse(window.sessionStorage.getItem(SEAT_KEY) ?? 'null') as Seat | null
    return seat?.code && (seat.team === 1 || seat.team === 2) ? seat : null
  } catch {
    return null
  }
}

function saveSeat(seat: Seat | null) {
  try {
    if (seat) window.sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat))
    else window.sessionStorage.removeItem(SEAT_KEY)
  } catch {
    // Sin almacenamiento: al recargar habrá que volver a elegir equipo.
  }
}

// supabase-js devuelve el canal que ya exista con ese nombre aunque se esté cerrando (al salir y volver
// a entrar, o en modo estricto), y entonces no se le pueden añadir escuchas: se cierra antes del todo.
async function freshChannel(client: SupabaseClient, name: string, options: Parameters<SupabaseClient['channel']>[1]) {
  for (const existing of client.getChannels()) {
    if (existing.topic === `realtime:${name}`) await client.removeChannel(existing)
  }
  return client.channel(name, options)
}

function systemEntry(variant: SystemVariant, text: string): ChatEntry {
  return { kind: 'system', id: `sys-${Date.now()}-${Math.random()}`, variant, text, created_at: new Date().toISOString() }
}

function sameRoster(a: RosterPlayer[], b: RosterPlayer[]) {
  return a.length === b.length && a.every((player, index) => {
    const other = b[index]
    return player.user_id === other.user_id && player.slot === other.slot && player.team === other.team && player.display_name === other.display_name
  })
}

const timeFormat = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

function formatTime(iso: string) {
  return timeFormat.format(new Date(iso))
}

function loadJson<T>(url: string): Promise<T> {
  return fetch(url, { cache: 'no-store' }).then(async (response) => {
    if (!response.ok) throw new Error(`No se pudo cargar ${url}`)
    return (await response.json()) as T
  })
}

function App() {
  const [characters, setCharacters] = useState<string[]>([])
  const [userId, setUserId] = useState('')
  const [room, setRoom] = useState<Room | null>(null)
  const [player, setPlayer] = useState<Player | null>(null)
  // Último tablero confirmado por el servidor; lo que se ve es este más los cambios en vuelo (flipped).
  const [serverBoard, setServerBoard] = useState<TeamBoard | null>(null)
  const flipOverridesRef = useRef(new Map<string, FlipOverride>())
  const flipTimerRef = useRef(0)
  const [flipTick, setFlipTick] = useState(0)
  // Fichas bajadas por el equipo rival: solo el número, nunca cuáles.
  const [opponentDown, setOpponentDown] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const lastMessageIdRef = useRef(0)
  const [systemEntries, setSystemEntries] = useState<ChatEntry[]>([])
  // Jugadores activos según la base de datos: es lo que cuentan la barra superior y los cursores.
  const [roster, setRoster] = useState<RosterPlayer[]>([])
  // Compañeros de los que ya llegan cursores aunque aún no salgan en la lista (acaban de entrar).
  const [packetUsers, setPacketUsers] = useState<Record<string, RemotePlayer>>({})
  const [chatMuted, setChatMuted] = useState(readChatMuted)
  const chatMutedRef = useRef(chatMuted)
  const [teamPick, setTeamPick] = useState<TeamPick | null>(null)
  const teamPickRef = useRef(teamPick)
  teamPickRef.current = teamPick
  const [name, setName] = useState('')
  const [joinCode, setJoinCode] = useState(new URLSearchParams(window.location.search).get('room') ?? '')
  // Puestos ocupados de la sala buscada; null mientras no se haya encontrado ninguna.
  const [lookup, setLookup] = useState<{ code: string; occupants: RoomOccupant[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [cursorReceiver] = useState(() => new CursorReceiver())
  const senderRef = useRef<CursorSender | null>(null)
  const roomChannelRef = useRef<RealtimeChannel | null>(null)
  const teamChannelRef = useRef<RealtimeChannel | null>(null)
  const currentDownRef = useRef(false)
  const initializedRef = useRef(false)
  const pendingLeaveRef = useRef<Promise<void>>(Promise.resolve())
  const stageRef = useRef<HTMLDivElement>(null)
  const ownLabelRef = useRef<HTMLDivElement>(null)
  const ownCursorImage = useScaledCursor(!SPECTATING && Boolean(player))
  // Callbacks estables para los componentes memoizados: así un mensaje no vuelve a pintar el tablero.
  const handleFlipRef = useRef(handleFlip)
  handleFlipRef.current = handleFlip
  const onFlip = useCallback((character: string) => handleFlipRef.current(character), [])
  const handleSendChatRef = useRef(handleSendChat)
  handleSendChatRef.current = handleSendChat
  const onSendChat = useCallback((body: string) => handleSendChatRef.current(body), [])
  const onToggleMute = useCallback(() => setChatMuted((current) => !current), [])
  const rejoiningRef = useRef(false)
  const rejoinRef = useRef(rejoin)
  rejoinRef.current = rejoin

  lastMessageIdRef.current = messages.length ? messages[messages.length - 1].id : 0

  // Quita los cambios caducados, programa el siguiente instante en que cambie alguno y repinta.
  const refreshFlips = useCallback(() => {
    window.clearTimeout(flipTimerRef.current)
    const now = Date.now()
    let next = Infinity
    for (const [character, override] of flipOverridesRef.current) {
      if (now >= override.until) {
        flipOverridesRef.current.delete(character)
        continue
      }
      next = Math.min(next, override.applyAt > now ? override.applyAt : override.until)
    }
    if (next !== Infinity) flipTimerRef.current = window.setTimeout(refreshFlips, next - now + 1)
    setFlipTick((tick) => tick + 1)
  }, [])

  // Aplica un tablero llegue por donde llegue (respuesta propia, compañero o latido) si es más nuevo.
  const applyServerBoard = useCallback((incoming: BoardUpdate) => {
    setServerBoard((current) => {
      if (!current) return current
      if (incoming.version !== undefined && current.version !== undefined && incoming.version <= current.version) return current
      return { ...current, flipped: incoming.flipped, version: incoming.version ?? current.version }
    })
  }, [])

  // El personaje solo pasa de vacío a elegido, así que un valor vacío (respuesta antigua) se ignora.
  const applyCharacter = useCallback((character: string | null | undefined) => {
    if (!character) return
    setServerBoard((current) => (current && current.character !== character ? { ...current, character } : current))
  }, [])

  const applyPick = useCallback((incoming: TeamPick | null | undefined) => {
    if (!incoming?.character) return
    setTeamPick((current) => (isNewerPick(incoming, current) ? incoming : current))
  }, [])

  // Une mensajes nuevos sin duplicar, en orden y quedándose con los 100 últimos.
  const mergeMessages = useCallback((incoming: ChatMessage[]) => {
    setMessages((current) => {
      const byId = new Map(current.map((message) => [message.id, message]))
      let changed = false
      for (const message of incoming) {
        if (byId.has(message.id)) continue
        byId.set(message.id, message)
        changed = true
      }
      if (!changed) return current
      return [...byId.values()].sort((a, b) => a.id - b.id).slice(-100)
    })
  }, [])

  const flipped = useMemo(() => {
    const result = new Set(serverBoard?.flipped ?? [])
    const now = Date.now()
    for (const [character, override] of flipOverridesRef.current) {
      if (now >= override.until) continue
      const down = now < override.applyAt ? !override.down : override.down
      if (down) result.add(character)
      else result.delete(character)
    }
    return result
    // flipTick fuerza el recálculo cuando cambian los overrides (que viven en un ref).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverBoard, flipTick])

  const refreshRoomData = useCallback(async (activeRoom: Room, activePlayer: Player) => {
    if (!supabase) return
    const [newBoard, newMessages] = await Promise.all([
      getTeamBoard(supabase, activeRoom.id, activePlayer.team),
      getTeamMessages(supabase, activeRoom.id, activePlayer.team),
    ])
    setServerBoard(newBoard)
    setMessages(newMessages)
  }, [])

  const enterRoom = useCallback(
    async (activeRoom: Room) => {
      if (!supabase || !userId) return
      const players = await getPlayers(supabase, activeRoom.id)
      const me = players.find((candidate) => candidate.user_id === userId)
      if (!me) throw new Error('El usuario no tiene un puesto en esta sala.')
      await refreshRoomData(activeRoom, me)
      setRoom(activeRoom)
      setPlayer(me)
      setRoster(players)
      saveSeat({ code: activeRoom.code, team: me.team, name: me.display_name })
      const params = new URLSearchParams(window.location.search)
      params.set('room', activeRoom.code)
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`)
    },
    [refreshRoomData, userId],
  )

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const [{ characters: manifestCharacters }, user] = await Promise.all([
          loadJson<{ characters: string[] }>(`${import.meta.env.BASE_URL}characters.json`),
          isSupabaseConfigured ? ensureAnonymousSession() : Promise.resolve(null),
        ])
        if (!mounted) return
        setCharacters(manifestCharacters)
        if (user) setUserId(user.id)
      } catch (caught) {
        if (mounted) setError(errorText(caught))
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    chatMutedRef.current = chatMuted
    try {
      window.localStorage.setItem(CHAT_MUTED_KEY, chatMuted ? '1' : '0')
    } catch {
      // Almacenamiento no disponible: la preferencia solo dura esta sesión.
    }
  }, [chatMuted])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!SPECTATING || !userId || !supabase || initializedRef.current) return
    initializedRef.current = true
    const client = supabase

    ;(async () => {
      try {
        const { room: watchedRoom, team } = await spectateTeam(client, OBS_KEY)
        // El espectador reutiliza la vista de juego con un jugador ficticio que no está en room_players,
        // así que no ocupa puesto ni cuenta como jugador.
        const viewer: Player = {
          room_id: watchedRoom.id,
          user_id: userId,
          team,
          slot: team === 1 ? 1 : 3,
          display_name: 'OBS',
          joined_at: new Date().toISOString(),
        }
        await refreshRoomData(watchedRoom, viewer)
        setRoom(watchedRoom)
        setPlayer(viewer)
      } catch (caught) {
        setError(errorText(caught))
      }
    })()
  }, [refreshRoomData, userId])

  useEffect(() => {
    if (SPECTATING || !userId || !supabase || initializedRef.current) return
    const codeFromUrl = new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase()
    if (!codeFromUrl) return
    initializedRef.current = true
    const client = supabase

    ;(async () => {
      try {
        // Al recargar la pestaña el puesto se liberó: se vuelve a entrar en el mismo equipo con el mismo nick.
        const seat = readSeat()
        if (seat?.code === codeFromUrl) {
          setName(seat.name)
          await enterRoom(await joinTeam(client, seat.code, seat.team, seat.name))
          return
        }
        const existingRoom = await getRoomByCode(client, codeFromUrl)
        if (existingRoom) await enterRoom(existingRoom)
      } catch (caught) {
        saveSeat(null)
        setError(errorText(caught))
      }
    })()
  }, [enterRoom, userId])

  useEffect(() => {
    if (!room || !player || !supabase) return
    const client = supabase
    const receiver = cursorReceiver
    let alive = true
    let roomChannel: RealtimeChannel | null = null
    let teamChannel: RealtimeChannel | null = null
    let sender: CursorSender | null = null
    let opponentVersion = -1

    setSystemEntries(SPECTATING ? [] : [systemEntry('self', 'Has entrado en la sala')])

    receiver.handlers = {
      onUser: (id, slot, displayName) => {
        if (alive) setPacketUsers((current) => ({ ...current, [id]: { userId: id, slot: slot as Slot, name: displayName } }))
      },
      // El clic de un compañero se aplica cuando su cursor remoto llega a la ficha (ver cursors.ts).
      onFlip: (character, down, applyAt) => {
        if (!alive) return
        flipOverridesRef.current.set(character, { down, applyAt, until: Math.max(applyAt, Date.now()) + FLIP_HOLD_MS })
        refreshFlips()
      },
    }

    const applyOpponentCount = (down: number, version?: number) => {
      if (version !== undefined) {
        if (version < opponentVersion) return
        opponentVersion = version
      }
      setOpponentDown(down)
    }

    // Lista de jugadores: los avisos de entrada y salida salen de comparar la lista anterior con la nueva.
    let known: Map<string, RosterPlayer> | null = null
    const applyRoster = (players: RosterPlayer[]) => {
      const next = new Map(players.map((candidate) => [candidate.user_id, candidate]))
      if (!SPECTATING) {
        const entries: ChatEntry[] = []
        for (const [id, candidate] of next) {
          if (id === player.user_id || known?.has(id)) continue
          entries.push(known
            ? systemEntry('join', `${candidate.display_name} ha entrado en la sala`)
            : systemEntry('info', `${candidate.display_name} está en la sala`))
        }
        for (const [id, candidate] of known ?? []) {
          if (id !== player.user_id && !next.has(id)) entries.push(systemEntry('leave', `${candidate.display_name} ha salido de la sala`))
        }
        if (entries.length) setSystemEntries((list) => [...list, ...entries])
      }
      const departed = new Set([...(known?.keys() ?? [])].filter((id) => !next.has(id)))
      for (const id of departed) receiver.forget(id)
      known = next
      setRoster((current) => (sameRoster(current, players) ? current : players))
      // Quien ya está en la lista se dibuja por ella y quien se ha ido deja de dibujarse; el resto
      // (acaba de entrar y aún no sale en la lista) se mantiene.
      setPacketUsers((current) => {
        const ids = Object.keys(current).filter((id) => next.has(id) || departed.has(id))
        if (!ids.length) return current
        const rest = { ...current }
        for (const id of ids) delete rest[id]
        return rest
      })
    }

    let syncing = false
    let syncAgain = false
    let syncTimer = 0
    let syncedPlayers = 0
    const runSync = async () => {
      if (syncing) {
        syncAgain = true
        return
      }
      syncing = true
      window.clearTimeout(syncTimer)
      try {
        const state = await syncRoom(client, room.id)
        if (!alive) return
        if (!state.member) {
          // Se le borró el puesto (más de 2 minutos sin latido): vuelve a entrar.
          if (!SPECTATING) void rejoinRef.current()
          return
        }
        syncedPlayers = state.players.length
        applyRoster(state.players)
        if (state.board) applyServerBoard(state.board)
        applyCharacter(state.character)
        const rival = state.down?.[String(player.team === 1 ? 2 : 1)]
        if (rival) applyOpponentCount(rival.down, rival.v)
        // Algún mensaje se perdió (p. ej. durante un corte): se vuelven a leer los últimos.
        if (state.last_message_id && state.last_message_id > lastMessageIdRef.current) {
          mergeMessages(await getTeamMessages(client, room.id, player.team))
        }
      } catch {
        // Se reintenta en el siguiente latido.
      } finally {
        syncing = false
        if (alive) {
          if (syncAgain) {
            syncAgain = false
            void runSync()
          } else {
            const wait = !SPECTATING ? SYNC_PLAYER_MS : syncedPlayers ? SYNC_OBS_MS : SYNC_OBS_EMPTY_MS
            syncTimer = window.setTimeout(runSync, wait)
          }
        }
      }
    }
    // Varios avisos seguidos (presencia, broadcast) se juntan en una sola consulta.
    const pendingSyncs = new Map<number, number>()
    const syncSoon = (delay: number) => {
      const at = Date.now() + delay
      for (const other of pendingSyncs.values()) if (Math.abs(other - at) < 250) return
      const timer = window.setTimeout(() => {
        pendingSyncs.delete(timer)
        void runSync()
      }, delay)
      pendingSyncs.set(timer, at)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void runSync()
    }
    document.addEventListener('visibilitychange', onVisible)
    void runSync()

    ;(async () => {
      // Canal de sala (poco tráfico): presencia (solo como aviso para sincronizar) y recuento del rival.
      const roomCh = await freshChannel(client, `room-${room.id}`, {
        config: { broadcast: { self: false }, presence: { key: player.user_id } },
      })
      // Canal del equipo: cursores, fichas y chat. El rival y su OBS no reciben estos mensajes.
      const teamCh = await freshChannel(client, `room-${room.id}-team-${player.team}`, {
        config: { broadcast: { self: false } },
      })
      if (!alive) {
        void client.removeChannel(roomCh)
        void client.removeChannel(teamCh)
        return
      }
      roomChannel = roomCh
      teamChannel = teamCh
      roomChannelRef.current = roomCh
      teamChannelRef.current = teamCh

      let subscribedOnce = false
      roomCh
        // Quien cambia una ficha anuncia el nuevo recuento de su equipo; el rival lo pinta en su mini-tablero.
        .on('broadcast', { event: 'board-count' }, ({ payload }) => {
          const count = payload as BoardCount
          if (count?.team && count.team !== player.team) applyOpponentCount(count.down, count.v)
        })
        // Alguien entra o sale: se consulta la lista enseguida. Al salir se repite por si su
        // leave_room aún no había terminado.
        .on('broadcast', { event: 'roster' }, () => syncSoon(150))
        .on('presence', { event: 'join' }, () => syncSoon(300))
        .on('presence', { event: 'leave' }, () => {
          syncSoon(300)
          syncSoon(2500)
        })
        .subscribe((status) => {
          if (!alive || status !== 'SUBSCRIBED') return
          // Tras un corte se vuelve a sincronizar por si se perdió algo mientras tanto.
          if (subscribedOnce) void runSync()
          subscribedOnce = true
          // El espectador solo escucha: no cuenta como conectado.
          if (SPECTATING) return
          void roomCh.track({ user_id: player.user_id })
          void roomCh.send({ type: 'broadcast', event: 'roster', payload: {} })
        })

      teamCh
        .on('broadcast', { event: 'cursor' }, ({ payload }) => receiver.receive(payload as CursorPacket))
        .on('broadcast', { event: 'board' }, ({ payload }) => {
          const incoming = payload as BoardUpdate
          if (!Array.isArray(incoming?.flipped)) return
          // Reinicio: se descartan los cambios en vuelo y se aplica al momento.
          if (incoming.reset) {
            flipOverridesRef.current.clear()
            refreshFlips()
          }
          applyServerBoard(incoming)
        })
        .on('broadcast', { event: 'character' }, ({ payload }) => {
          applyCharacter((payload as { character?: string } | null)?.character)
        })
        .on('broadcast', { event: 'pick' }, ({ payload }) => applyPick(payload as TeamPick))
        // Quien acaba de conectarse (compañero u OBS) pregunta qué héroe está marcado.
        .on('broadcast', { event: 'pick-sync' }, () => {
          const pick = teamPickRef.current
          if (pick && !SPECTATING) void teamCh.send({ type: 'broadcast', event: 'pick', payload: pick })
        })
        .on('broadcast', { event: 'chat' }, ({ payload }) => {
          const incoming = payload as ChatMessage
          if (!incoming?.id || incoming.team !== player.team) return
          mergeMessages([incoming])
          if (!SPECTATING && incoming.user_id !== player.user_id && !chatMutedRef.current) playChatSound()
        })
        .subscribe((status) => {
          if (!alive || status !== 'SUBSCRIBED') return
          sender?.resend()
          void teamCh.send({ type: 'broadcast', event: 'pick-sync', payload: {} })
        })

      if (!SPECTATING) {
        sender = new CursorSender(
          // Sin conexión se descarta (send() caería a la API REST); al reconectar se reenvía la posición.
          (packet) => {
            if (teamCh.state === 'joined') void teamCh.send({ type: 'broadcast', event: 'cursor', payload: packet })
          },
          { userId: player.user_id, slot: player.slot, name: player.display_name },
        )
        senderRef.current = sender
      }
    })()

    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
      window.clearTimeout(syncTimer)
      for (const timer of pendingSyncs.keys()) window.clearTimeout(timer)
      sender?.dispose()
      senderRef.current = null
      receiver.handlers = {}
      receiver.reset()
      window.clearTimeout(flipTimerRef.current)
      flipOverridesRef.current.clear()
      if (roomChannel) void client.removeChannel(roomChannel)
      if (teamChannel) void client.removeChannel(teamChannel)
      roomChannelRef.current = null
      teamChannelRef.current = null
      setOpponentDown(0)
      setPacketUsers({})
      setTeamPick(null)
    }
    // The callback is intentionally kept stable through refs/state below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, player])

  // Escala el lienzo para que quepa entero en la ventana, centrado. Los cursores y avisos van fuera de
  // él (position: fixed) y el tablero se mide con getBoundingClientRect, que ya incluye la escala.
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const fit = () => {
      const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT)
      const x = (window.innerWidth - STAGE_WIDTH * scale) / 2
      const y = (window.innerHeight - STAGE_HEIGHT * scale) / 2
      stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [room, player])

  // Cerrar o recargar la pestaña cuenta como salir de la sala: se libera el puesto al momento.
  useEffect(() => {
    if (!room || SPECTATING) return
    const onPageHide = () => leaveRoomOnUnload(room.id)
    // Si el navegador restaura la página de su caché tras haberla dejado, se recarga para volver a entrar.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload()
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [room])

  useEffect(() => {
    if (!room || !player || SPECTATING) return
    let lastX = -1
    let lastY = -1
    const move = (event: PointerEvent) => {
      lastX = event.clientX
      lastY = event.clientY
      // El cursor propio es el nativo del sistema; aquí solo se mueve la etiqueta, sin pasar por React.
      const label = ownLabelRef.current
      if (label) {
        label.style.transform = `translate3d(${event.clientX + OWN_LABEL_OFFSET.x}px, ${event.clientY + OWN_LABEL_OFFSET.y}px, 0)`
        label.style.opacity = '1'
      }
      senderRef.current?.sample(event.clientX, event.clientY, currentDownRef.current)
    }
    const setDown = (down: boolean, x: number, y: number) => {
      currentDownRef.current = down
      if (x >= 0) senderRef.current?.sample(x, y, down, true)
    }
    const down = (event: PointerEvent) => setDown(true, event.clientX, event.clientY)
    const up = (event: PointerEvent) => setDown(false, event.clientX, event.clientY)
    const blur = () => {
      if (currentDownRef.current) setDown(false, lastX, lastY)
    }
    const hideLabel = () => {
      if (ownLabelRef.current) ownLabelRef.current.style.opacity = '0'
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('blur', blur)
    document.documentElement.addEventListener('pointerleave', hideLabel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('blur', blur)
      document.documentElement.removeEventListener('pointerleave', hideLabel)
    }
  }, [room, player])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (!supabase || !userId) return setError('No se ha inicializado la conexión con Supabase.')
    setBusy(true)
    setError('')
    try {
      const newRoom = await createRoom(supabase, characters, name, userId)
      await enterRoom(newRoom)
      setNotice(`Sala creada: ${newRoom.code}`)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  function handleJoinCodeChange(value: string) {
    setJoinCode(value)
    setLookup(null)
  }

  async function handleFindRoom(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return setError('No se ha inicializado la conexión con Supabase.')
    const code = joinCode.trim().toUpperCase()
    setBusy(true)
    setError('')
    try {
      await pendingLeaveRef.current
      setLookup({ code, occupants: await getRoomAvailability(supabase, code) })
    } catch (caught) {
      setLookup(null)
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function handlePickTeam(team: Team) {
    if (!supabase || !lookup) return
    setBusy(true)
    setError('')
    try {
      await pendingLeaveRef.current
      const joinedRoom = await joinTeam(supabase, lookup.code, team, name)
      await enterRoom(joinedRoom)
      setLookup(null)
      setNotice(`Has entrado en ${joinedRoom.code}.`)
    } catch (caught) {
      setError(errorText(caught))
      // Otro jugador pudo ocupar el puesto mientras tanto: refresca los huecos.
      getRoomAvailability(supabase, lookup.code)
        .then((occupants) => setLookup({ code: lookup.code, occupants }))
        .catch(() => setLookup(null))
    } finally {
      setBusy(false)
    }
  }

  // El puesto se perdió por inactividad (p. ej. el equipo estuvo suspendido): se vuelve a pedir.
  async function rejoin() {
    if (!supabase || !room || !player || SPECTATING || rejoiningRef.current) return
    rejoiningRef.current = true
    try {
      await enterRoom(await joinTeam(supabase, room.code, player.team, player.display_name))
    } catch (caught) {
      leaveRoom()
      setError(`Has perdido tu puesto en la sala: ${errorText(caught)}`)
    } finally {
      rejoiningRef.current = false
    }
  }

  async function handleFlip(character: string) {
    if (!supabase || !room || !player || SPECTATING) return
    setError('')
    // La ficha se mueve al instante y se mantiene así mientras llega el tablero confirmado, para que
    // una respuesta intermedia no devuelva a su sitio una ficha recién pulsada.
    const down = !flipped.has(character)
    const now = Date.now()
    const override: FlipOverride = { down, applyAt: now, until: now + FLIP_HOLD_MS }
    flipOverridesRef.current.set(character, override)
    refreshFlips()
    // Viaja con el cursor para que compañero y OBS la vean bajar justo cuando el cursor hace clic.
    senderRef.current?.flip(character, down)
    try {
      const updated = await toggleCard(supabase, room.id, player.team, character)
      if (updated) {
        const board: BoardUpdate = { flipped: updated.flipped, version: updated.version }
        applyServerBoard(board)
        void teamChannelRef.current?.send({ type: 'broadcast', event: 'board', payload: board })
        void roomChannelRef.current?.send({
          type: 'broadcast',
          event: 'board-count',
          payload: { team: player.team, down: updated.flipped.length, v: updated.version } satisfies BoardCount,
        })
      }
      override.until = Math.max(override.until, Date.now() + 1200)
    } catch (caught) {
      if (flipOverridesRef.current.get(character) === override) flipOverridesRef.current.delete(character)
      setError(errorText(caught))
    } finally {
      refreshFlips()
    }
  }

  async function handleReset() {
    if (!supabase || !room || !player || SPECTATING) return
    setBusy(true)
    try {
      const updated = await resetTeamBoard(supabase, room.id, player.team)
      if (updated) {
        const board: BoardUpdate = { flipped: updated.flipped, version: updated.version, reset: true }
        flipOverridesRef.current.clear()
        refreshFlips()
        applyServerBoard(board)
        void teamChannelRef.current?.send({ type: 'broadcast', event: 'board', payload: board })
        void roomChannelRef.current?.send({
          type: 'broadcast',
          event: 'board-count',
          payload: { team: player.team, down: updated.flipped.length, v: updated.version } satisfies BoardCount,
        })
      }
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function handleSendChat(body: string) {
    if (!supabase || !room || !player || SPECTATING || !body) return
    try {
      const sent = await sendMessage(supabase, {
        room_id: room.id,
        team: player.team,
        user_id: player.user_id,
        display_name: player.display_name,
        body: body.slice(0, 280),
      })
      mergeMessages([sent])
      void teamChannelRef.current?.send({ type: 'broadcast', event: 'chat', payload: sent })
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  // Marca un héroe para todo el equipo. `at` siempre supera al marcado actual aunque los relojes difieran.
  function handlePick(character: string) {
    if (!player || SPECTATING) return
    const at = Math.max(Date.now(), (teamPickRef.current?.at ?? 0) + 1)
    const pick: TeamPick = { character, at, by: player.user_id }
    applyPick(pick)
    void teamChannelRef.current?.send({ type: 'broadcast', event: 'pick', payload: pick })
  }

  async function handleChooseCharacter(character: string) {
    if (!supabase || !room || !player || SPECTATING) return
    setBusy(true)
    setError('')
    try {
      const chosen = await chooseTeamCharacter(supabase, room.id, player.team, character)
      if (chosen) {
        applyCharacter(chosen)
        void teamChannelRef.current?.send({ type: 'broadcast', event: 'character', payload: { character: chosen } })
      }
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function handleCopyObsLink() {
    if (!serverBoard?.spectator_key) return setError('El enlace OBS aún no está disponible. Revisa que la migración esté aplicada.')
    const link = obsLink(serverBoard.spectator_key)
    try {
      await navigator.clipboard.writeText(link)
      setNotice('Enlace OBS copiado. Pégalo como URL de una fuente de navegador.')
    } catch {
      window.prompt('Copia el enlace OBS:', link)
    }
  }

  async function handleCopyRoomCode() {
    if (!room) return
    try {
      await navigator.clipboard.writeText(room.code)
      setNotice(`Código de sala copiado: ${room.code}`)
    } catch {
      window.prompt('Copia el código de la sala:', room.code)
    }
  }

  function leaveRoom() {
    if (supabase && room) {
      // Libera el puesto para poder volver a entrar en cualquier equipo. Cuando ya está libre se avisa a
      // la sala (por HTTP: el canal ya se habrá cerrado) para que todos actualicen la lista al momento.
      const channel = roomChannelRef.current
      pendingLeaveRef.current = leaveRoomRpc(supabase, room.id)
        .then(() => {
          void channel?.httpSend('roster', {}).catch(() => {})
        })
        .catch((caught) => setError(errorText(caught)))
      setJoinCode(room.code)
    }
    saveSeat(null)
    setRoster([])
    setLookup(null)
    setRoom(null)
    setPlayer(null)
    setServerBoard(null)
    setMessages([])
    setSystemEntries([])
    setNotice('')
    const params = new URLSearchParams(window.location.search)
    params.delete('room')
    window.history.replaceState({}, '', params.size ? `${window.location.pathname}?${params}` : window.location.pathname)
  }

  const setupWarning = characters.length < 24
  const chatEntries = useMemo(
    () =>
      [...messages.map((message): ChatEntry => ({ kind: 'chat', ...message })), ...systemEntries]
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    [messages, systemEntries],
  )
  const remotePlayers = useMemo(() => {
    const list = new Map<string, RemotePlayer>()
    if (!player) return []
    // La vista OBS no tiene cursor propio: pinta a todos, aunque comparta sesión con un jugador
    // (enlace abierto en el mismo navegador).
    const isSelf = (id: string) => !SPECTATING && id === player.user_id
    for (const candidate of roster) {
      if (isSelf(candidate.user_id) || candidate.team !== player.team) continue
      list.set(candidate.user_id, { userId: candidate.user_id, slot: candidate.slot, name: candidate.display_name })
    }
    for (const remote of Object.values(packetUsers)) {
      if (!isSelf(remote.userId) && !list.has(remote.userId)) list.set(remote.userId, remote)
    }
    return [...list.values()]
  }, [roster, packetUsers, player])

  if (!isSupabaseConfigured) {
    return <SetupScreen />
  }

  if (SPECTATING && (!room || !player)) {
    return <div className="obs-status">{error || 'Conectando vista OBS…'}</div>
  }

  if (!room || !player) {
    return (
      <LandingScreen
        characters={characters}
        setupWarning={setupWarning}
        name={name}
        setName={setName}
        joinCode={joinCode}
        setJoinCode={handleJoinCodeChange}
        lookup={lookup}
        busy={busy}
        error={error}
        notice={notice}
        onCreate={handleCreate}
        onFindRoom={handleFindRoom}
        onPickTeam={handlePickTeam}
      />
    )
  }

  const onlineCount = Math.min(4, roster.length)
  const ownCursorStyle = ownCursorImage ? ({ '--own-cursor': cursorCss(ownCursorImage) } as CSSProperties) : undefined
  // Fondo de la vista OBS, uno por equipo, con huecos transparentes donde van las cámaras.
  const stageStyle = SPECTATING
    ? { backgroundImage: `url("${import.meta.env.BASE_URL}backgrounds/${player.team === 1 ? 'obs-azul' : 'obs-rojo'}.png")` }
    : undefined

  return (
    <div
      className={`app-shell game-shell ${TEAM_COLORS[player.team]} ${ownCursorImage ? 'own-cursor' : ''} ${SPECTATING ? 'obs-view' : ''}`}
      style={ownCursorStyle}
    >
      {/* Lienzo de 1920×1080; el equipo rojo lo ve en espejo (ver .game-shell.red en styles.css). */}
      <div className="stage" ref={stageRef} style={stageStyle}>
        <aside className="team-cams">
          <div className="camera-slot" />
          <div className="camera-slot" />
        </aside>

        <div className="stage-main">
          <div className="top-row">
            <section className="chat-panel">
              <header className="game-toolbar">
                <h1>{TEAM_NAMES[player.team]}</h1>
                {/* En la vista OBS solo se ven el equipo y su personaje. */}
                {!SPECTATING && (
                  <div className="toolbar-meta">
                    Sala <strong>{room.code}</strong> · {onlineCount}/4
                  </div>
                )}
                <TeamCharacterBadge character={serverBoard?.character ?? null} />
                <div className="toolbar-actions">
                  <button
                    type="button"
                    className="mute-button"
                    onClick={onToggleMute}
                    aria-pressed={chatMuted}
                    aria-label={chatMuted ? 'Activar sonido del chat' : 'Silenciar chat'}
                    title={chatMuted ? 'Activar sonido del chat' : 'Silenciar chat'}
                  >
                    {chatMuted ? '🔕' : '🔔'}
                  </button>
                  <button className="ghost-button" onClick={handleReset} disabled={busy}>
                    Reiniciar fichas
                  </button>
                  <button className="ghost-button" onClick={handleCopyObsLink} title="Copia el enlace de la vista OBS de tu equipo">
                    Enlace OBS
                  </button>
                  <button className="danger-button" onClick={leaveRoom}>
                    Salir
                  </button>
                </div>
              </header>
              <TeamChat entries={chatEntries} onSend={onSendChat} />
            </section>
            <div className="rival-cams">
              <div className="camera-slot" />
              <div className="camera-slot" />
            </div>
          </div>

          <OpponentStrip team={player.team === 1 ? 2 : 1} total={room.characters.length} down={opponentDown} />

          <main className="board-wrap">
            <section className="board-grid" aria-label="Personajes" ref={setBoardElement}>
              {room.characters.map((character) => (
                <CharacterCard
                  key={character}
                  character={character}
                  isDown={flipped.has(character)}
                  onToggle={onFlip}
                />
              ))}
            </section>
          </main>
        </div>

        {serverBoard && !serverBoard.character && (
          <CharacterPicker
            team={player.team}
            roomCode={room.code}
            characters={room.characters}
            pick={teamPick}
            readOnly={SPECTATING}
            busy={busy}
            onPick={handlePick}
            onChoose={handleChooseCharacter}
            onCopyObsLink={handleCopyObsLink}
            onCopyRoomCode={handleCopyRoomCode}
            onLeave={leaveRoom}
          />
        )}
      </div>

      {notice && <div className="toast notice in-game">{notice}</div>}
      {error && <div className="toast error in-game">{error}</div>}

      <div className="cursor-layer" aria-hidden="true">
        {remotePlayers.map((remote) => (
          <RemoteCursor
            key={remote.userId}
            receiver={cursorReceiver}
            userId={remote.userId}
            slot={remote.slot}
            team={player.team}
            name={remote.name}
          />
        ))}
        <div ref={ownLabelRef} className={`own-cursor-label ${TEAM_COLORS[player.team]}`}>
          {player.display_name}
        </div>
      </div>
    </div>
  )
}

function LandingScreen(props: {
  characters: string[]
  setupWarning: boolean
  name: string
  setName: (value: string) => void
  joinCode: string
  setJoinCode: (value: string) => void
  lookup: { code: string; occupants: RoomOccupant[] } | null
  busy: boolean
  error: string
  notice: string
  onCreate: (event: FormEvent) => void
  onFindRoom: (event: FormEvent) => void
  onPickTeam: (team: Team) => void
}) {
  const { lookup } = props

  return (
    <div className="app-shell lobby-shell">
      <div className="brand-lockup">
        <div className="brand-kicker">OVERWATCH</div>
        <h1>¿Quién es Quién?</h1>
        <p>2 vs 2 · 24 héroes · tablero independiente por equipo · chat privado de equipo</p>
      </div>

      {props.setupWarning && (
        <div className="setup-banner">
          Faltan personajes: tienes {props.characters.length} PNG y necesitas al menos 24. Mete los PNG en <code>public/characters/</code> y vuelve a ejecutar el build.
        </div>
      )}

      {props.error && <div className="toast error">{props.error}</div>}
      {props.notice && <div className="toast notice">{props.notice}</div>}

      <div className="lobby-grid">
        <form className="panel hero-panel" onSubmit={props.onCreate}>
          <span className="panel-label">ANFITRIÓN</span>
          <h2>Crear partida</h2>
          <p>Se elegirán 24 héroes aleatorios del contenido que hayas metido en la carpeta de personajes. Los dos equipos reciben exactamente la misma selección.</p>
          <label>
            Tu nombre
            <input value={props.name} onChange={(event) => props.setName(event.target.value)} maxLength={24} placeholder="Guaacha" />
          </label>
          <button className="primary-button" disabled={props.busy || props.setupWarning || !props.name.trim()}>
            {props.busy ? 'Creando…' : 'Crear partida'}
          </button>
        </form>

        <form className="panel" onSubmit={props.onFindRoom}>
          <span className="panel-label">JUGADOR</span>
          <h2>Unirse a una partida</h2>
          <div className="two-fields">
            <label>
              Código de sala
              <input value={props.joinCode} onChange={(event) => props.setJoinCode(event.target.value.toUpperCase())} maxLength={5} placeholder="ABCDE" />
            </label>
            <label>
              Tu nombre
              <input value={props.name} onChange={(event) => props.setName(event.target.value)} maxLength={24} placeholder="Jugador 2" />
            </label>
          </div>

          {lookup ? (
            <div className="team-picker">
              <span className="team-picker-title">Sala {lookup.code} · elige equipo</span>
              <div className="team-picker-options">
                {([1, 2] as Team[]).map((team) => {
                  const members = lookup.occupants.filter((occupant) => occupant.team === team)
                  const isMine = members.some((occupant) => occupant.is_me)
                  const free = 2 - members.length
                  const disabled = props.busy || !props.name.trim() || (free === 0 && !isMine)
                  return (
                    <button
                      type="button"
                      key={team}
                      className={`team-option ${TEAM_COLORS[team]}`}
                      disabled={disabled}
                      onClick={() => props.onPickTeam(team)}
                    >
                      <strong>{TEAM_NAMES[team]}</strong>
                      <span className="team-option-status">
                        {isMine ? 'Ya estás aquí · volver' : free === 0 ? 'Completo' : `${free} ${free === 1 ? 'hueco libre' : 'huecos libres'}`}
                      </span>
                      <span className="team-option-members">
                        {members.length ? members.map((occupant) => occupant.display_name).join(' · ') : 'Sin jugadores'}
                      </span>
                    </button>
                  )
                })}
              </div>
              {!props.name.trim() && <small>Escribe tu nombre para poder elegir equipo.</small>}
            </div>
          ) : (
            <>
              <button className="primary-button" disabled={props.busy || !props.joinCode.trim() || !props.name.trim()}>
                {props.busy ? 'Buscando…' : 'Unirme'}
              </button>
              <small>{props.joinCode.trim() ? 'Al encontrar la sala podrás elegir equipo.' : 'Primero escribe el código de la sala.'}</small>
            </>
          )}
        </form>
      </div>

      <div className="architecture-card">
        <div>
          <span className="panel-label">CÓMO FUNCIONA</span>
          <h3>Una misma sala, dos estados de juego.</h3>
        </div>
        <div className="architecture-flow">
          <span>24 héroes comunes</span><b>→</b><span>Equipo Azul</span><b>↔</b><span>Equipo Rojo</span>
        </div>
        <p>Cada equipo comparte sus fichas y su chat con sus dos jugadores, pero sus fichas/chat son independientes del rival. Los cuatro cursores se transmiten en tiempo real.</p>
      </div>
    </div>
  )
}

function SetupScreen() {
  return (
    <div className="app-shell lobby-shell">
      <div className="brand-lockup">
        <div className="brand-kicker">OVERWATCH</div>
        <h1>¿Quién es Quién?</h1>
        <p>La interfaz está lista, pero faltan las claves públicas de Supabase.</p>
      </div>
      <div className="setup-instructions panel">
        <h2>Configura Supabase</h2>
        <ol>
          <li>Copia <code>.env.example</code> como <code>.env</code>.</li>
          <li>Pega <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> de tu proyecto Supabase.</li>
          <li>Ejecuta <code>supabase/schema.sql</code> en el SQL Editor.</li>
          <li>Activa el login anónimo en Authentication → Providers.</li>
          <li>Añade los PNG de personajes y cursores a las carpetas indicadas.</li>
        </ol>
        <p>Después ejecuta <code>npm run dev</code> para probarlo localmente o <code>npm run build</code> para desplegarlo.</p>
      </div>
    </div>
  )
}

// El texto que se escribe vive aquí: teclear no vuelve a pintar la sala entera.
const TeamChat = memo(function TeamChat({
  entries,
  onSend,
}: {
  entries: ChatEntry[]
  onSend: (body: string) => void
}) {
  const [input, setInput] = useState('')
  const messagesRef = useRef<HTMLDivElement>(null)
  const hasChat = entries.some((entry) => entry.kind === 'chat')

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const body = input.trim()
    if (!body) return
    setInput('')
    onSend(body)
  }

  useEffect(() => {
    const list = messagesRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [entries])

  return (
    <div className="team-chat">
      <div className="chat-messages" ref={messagesRef}>
        {!hasChat && <div className="chat-empty">Escribe algo. Solo lo verá tu equipo.</div>}
        {entries.map((entry) =>
          entry.kind === 'chat' ? (
            <div className="chat-message" key={entry.id}>
              <div className="chat-message-head">
                <strong>{entry.display_name}</strong>
                <time dateTime={entry.created_at}>{formatTime(entry.created_at)}</time>
              </div>
              <span>{entry.body}</span>
            </div>
          ) : (
            <div className={`chat-system ${entry.variant}`} key={entry.id}>
              <span>{entry.text}</span>
              <time dateTime={entry.created_at}>{formatTime(entry.created_at)}</time>
            </div>
          ),
        )}
      </div>
      <form onSubmit={onSubmit} className="chat-form">
        <input value={input} onChange={(event) => setInput(event.target.value)} maxLength={280} placeholder="Mensaje…" />
        <button type="submit" aria-label="Enviar mensaje">↵</button>
      </form>
    </div>
  )
})

// Fondos del retrato: verdes, azules, morados, amarillos claros, rosas y marrones.
const PORTRAIT_COLORS = [
  '#2f8f5b', '#1f5f9e', '#6a3fa0', '#f2df8a', '#e07aa3', '#8a5a3b',
  '#4fae7a', '#2a7bbf', '#8a5cc7', '#e8cf6a', '#f2a7c3', '#a87650',
]

// El color depende solo del nombre, así un personaje tiene el mismo fondo en todas las salas y equipos.
function portraitColor(character: string) {
  let hash = 0
  for (const char of character) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PORTRAIT_COLORS[hash % PORTRAIT_COLORS.length]
}

const CharacterCard = memo(function CharacterCard({
  character,
  isDown,
  onToggle,
}: {
  character: string
  isDown: boolean
  onToggle: (character: string) => void
}) {
  return (
    <button
      className={`character-card ${isDown ? 'is-down' : ''}`}
      onClick={() => onToggle(character)}
      aria-pressed={isDown}
      data-name={character}
      style={cardStyle(character)}
    >
      <CardFace character={character} />
    </button>
  )
})

// La longitud del nombre reduce el tamaño de letra para que quepa en una sola línea (ficha y etiqueta de bajada).
function cardStyle(character: string) {
  return { '--name-len': Math.max(character.length, 5), '--portrait-bg': portraitColor(character) } as CSSProperties
}

function CardFace({ character }: { character: string }) {
  return (
    <div className="character-face">
      <div className="card-frame">
        <div className="portrait-frame">
          <img src={characterImage(character)} alt={character} loading="lazy" />
        </div>
        <div className="character-name">{character}</div>
      </div>
    </div>
  )
}

// Indicador del personaje del equipo en la cabecera (el rival nunca lo recibe).
function TeamCharacterBadge({ character }: { character: string | null }) {
  return (
    <div className={`character-badge ${character ? '' : 'is-empty'}`}>
      {character && (
        <span className="character-badge-portrait" style={{ '--portrait-bg': portraitColor(character) } as CSSProperties}>
          <img src={characterImage(character)} alt="" />
        </span>
      )}
      <span className="character-badge-text">
        Vuestro personaje: {character ? character : <span className="character-badge-empty">Sin elegir</span>}
      </span>
    </div>
  )
}

// Ventana para elegir el personaje del equipo. Sale mientras el equipo no tenga uno (también en la vista
// OBS, solo para mirar). El héroe marcado es el mismo para los dos compañeros, y en cuanto uno confirma
// se cierra para todos.
function CharacterPicker({
  team,
  characters,
  pick,
  readOnly,
  busy,
  onPick,
  onChoose,
  onCopyObsLink,
  onCopyRoomCode,
  onLeave,
  roomCode,
}: {
  team: Team
  roomCode: string
  characters: string[]
  pick: TeamPick | null
  readOnly: boolean
  busy: boolean
  onPick: (character: string) => void
  onChoose: (character: string) => void
  onCopyObsLink: () => void
  onCopyRoomCode: () => void
  onLeave: () => void
}) {
  const selected = pick?.character ?? null
  const rival = TEAM_NAMES[team === 1 ? 2 : 1]

  return (
    <div className="picker-overlay" role="dialog" aria-modal="true" aria-labelledby="picker-title">
      <div className={`picker-panel ${TEAM_COLORS[team]}`}>
        <span className="panel-label">{TEAM_NAMES[team].toUpperCase()}</span>
        <h2 id="picker-title">Elegid vuestro personaje</h2>
        <p>
          Es el héroe que el {rival} tendrá que adivinar. Solo lo veis vosotros. Lo elige uno de los dos y,
          una vez confirmado, no se puede cambiar.
        </p>
        <div className={`picker-grid ${selected ? 'has-selection' : ''}`}>
          {characters.map((character) => (
            <button
              type="button"
              key={character}
              className={`character-card picker-card ${selected === character ? 'is-selected' : ''}`}
              onClick={() => onPick(character)}
              disabled={readOnly}
              aria-pressed={selected === character}
              style={cardStyle(character)}
            >
              <CardFace character={character} />
            </button>
          ))}
        </div>
        <div className="picker-actions">
          <span className="picker-selection">
            {pick ? (
              <>Elegido: <strong>{pick.character}</strong></>
            ) : readOnly ? 'Esperando a que el equipo elija…' : 'Pulsa un héroe para elegirlo.'}
          </span>
          {!readOnly && (
            <>
              <button type="button" className="picker-room" onClick={onCopyRoomCode} title="Copia el código de la sala">
                Sala <strong>{roomCode}</strong>
              </button>
              <button type="button" className="ghost-button" onClick={onCopyObsLink} title="Copia el enlace de la vista OBS de tu equipo">
                Enlace OBS
              </button>
              <button type="button" className="danger-button" onClick={onLeave}>
                Salir
              </button>
              <button type="button" className="picker-confirm" disabled={!selected || busy} onClick={() => selected && onChoose(selected)}>
                Confirmar personaje
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Fichas del rival en miniatura: refleja cuántas tiene bajadas, pero no cuáles. Cada cambio baja o
// sube fichas al azar, así que las posiciones no coinciden con las del tablero real.
const OpponentStrip = memo(function OpponentStrip({ team, total, down }: { team: Team; total: number; down: number }) {
  const [downSlots, setDownSlots] = useState<Set<number>>(() => new Set())

  useEffect(() => {
    setDownSlots((current) => {
      const target = Math.max(0, Math.min(total, down))
      if (current.size === target) return current
      const next = new Set(current)
      if (target > current.size) {
        const up = Array.from({ length: total }, (_, index) => index).filter((index) => !next.has(index))
        for (const index of shuffle(up).slice(0, target - current.size)) next.add(index)
      } else {
        for (const index of shuffle([...next]).slice(0, current.size - target)) next.delete(index)
      }
      return next
    })
  }, [down, total])

  return (
    <section className={`opponent-strip ${TEAM_COLORS[team]}`} aria-label={`Tablero del ${TEAM_NAMES[team]}: ${downSlots.size} fichas bajadas`}>
      <span className="opponent-title">FICHAS DEL {TEAM_NAMES[team].toUpperCase()}</span>
      <div className="opponent-row">
        {Array.from({ length: total }, (_, index) => (
          <div key={index} className={`mini-card ${downSlots.has(index) ? 'is-down' : ''}`}>
            <div className="mini-face" />
          </div>
        ))}
      </div>
      <span className="opponent-count">
        <strong>{downSlots.size}</strong> / {total} bajadas
      </span>
    </section>
  )
})

// El movimiento lo dibuja CursorReceiver fotograma a fotograma, sin pasar por React (ver cursors.ts).
const RemoteCursor = memo(function RemoteCursor({
  receiver,
  userId,
  slot,
  team,
  name,
}: {
  receiver: CursorReceiver
  userId: string
  slot: Slot
  team: Team
  name: string
}) {
  const elementRef = useRef<HTMLDivElement>(null)

  // Layout effect: el primer fotograma ya sale en su sitio, sin pasar por la esquina superior izquierda.
  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) return
    return receiver.attach(userId, element, CURSOR_ANCHORS[slot] ?? CURSOR_ANCHORS[1])
  }, [receiver, userId, slot])

  // Las dos imágenes se cargan desde el principio: al hacer clic solo cambia cuál se ve.
  return (
    <div ref={elementRef} className={`remote-cursor ${TEAM_COLORS[team]}`}>
      <img src={CURSOR_FILE} alt="" />
      <span>{name}</span>
    </div>
  )
})

export default App
