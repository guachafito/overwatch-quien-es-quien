import { CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { ensureAnonymousSession, isSupabaseConfigured, supabase } from './supabase'
import {
  createRoom,
  getPlayers,
  getRoomByCode,
  getTeamBoard,
  getTeamMessages,
  getRoomAvailability,
  joinTeam,
  leaveRoom as leaveRoomRpc,
  resetTeamBoard,
  toggleCard,
} from './game'
import type { RoomOccupant } from './game'
import type { ChatMessage, CursorState, Player, Room, Slot, Team, TeamBoard } from './types'

const TEAM_NAMES: Record<Team, string> = { 1: 'Equipo Azul', 2: 'Equipo Rojo' }
const TEAM_COLORS: Record<Team, string> = { 1: 'blue', 2: 'red' }
const SLOTS: Slot[] = [1, 2, 3, 4]
const CURSOR_ANCHORS: Record<Slot, { x: number; y: number }> = {
  1: { x: 0.12, y: 0.34 },
  2: { x: 0.18, y: 0.62 },
  3: { x: 0.82, y: 0.34 },
  4: { x: 0.88, y: 0.62 },
}

function getSlotCursorFile(slot: Slot, down: boolean) {
  const secondStyle = slot % 2 === 0
  if (secondStyle) return down
    ? `${import.meta.env.BASE_URL}cursors/cursoragarrando2.png`
    : `${import.meta.env.BASE_URL}cursors/cursor2.png`
  return down
    ? `${import.meta.env.BASE_URL}cursors/cursoragarrando.png`
    : `${import.meta.env.BASE_URL}cursors/cursor.png`
}

// Tamaño y punto activo con los que se dibujan los cursores remotos (ver .remote-cursor en styles.css).
const CURSOR_SIZE = 58
const CURSOR_HOTSPOT = 4
const OWN_LABEL_OFFSET = { x: 30, y: 32 }

// Los navegadores no admiten cursores nativos de más de 128 px, así que los PNG se reducen en un canvas.
function scaleCursor(src: string) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = CURSOR_SIZE
      canvas.height = CURSOR_SIZE
      const context = canvas.getContext('2d')
      if (!context) return reject(new Error('Canvas no disponible'))
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, 0, 0, CURSOR_SIZE, CURSOR_SIZE)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = reject
    image.src = src
  })
}

function useScaledCursors(slot: Slot | undefined) {
  const [cursors, setCursors] = useState<{ up: string; down: string } | null>(null)

  useEffect(() => {
    setCursors(null)
    if (!slot) return
    let alive = true
    Promise.all([scaleCursor(getSlotCursorFile(slot, false)), scaleCursor(getSlotCursorFile(slot, true))])
      .then(([up, down]) => {
        if (alive) setCursors({ up, down })
      })
      .catch(() => {
        // Si las imágenes no cargan se queda el cursor normal del sistema.
      })
    return () => {
      alive = false
    }
  }, [slot])

  return cursors
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

type PresenceMeta = { user_id: string; display_name: string }

function systemEntry(variant: SystemVariant, text: string): ChatEntry {
  return { kind: 'system', id: `sys-${Date.now()}-${Math.random()}`, variant, text, created_at: new Date().toISOString() }
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
  const [players, setPlayers] = useState<Player[]>([])
  const [board, setBoard] = useState<TeamBoard | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [systemEntries, setSystemEntries] = useState<ChatEntry[]>([])
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set())
  const [chatMuted, setChatMuted] = useState(readChatMuted)
  const chatMutedRef = useRef(chatMuted)
  const [name, setName] = useState('')
  const [joinCode, setJoinCode] = useState(new URLSearchParams(window.location.search).get('room') ?? '')
  // Puestos ocupados de la sala buscada; null mientras no se haya encontrado ninguna.
  const [lookup, setLookup] = useState<{ code: string; occupants: RoomOccupant[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [cursorStates, setCursorStates] = useState<Record<string, CursorState>>({})
  const cursorChannelRef = useRef<RealtimeChannel | null>(null)
  const lastCursorSentRef = useRef(0)
  const currentDownRef = useRef(false)
  const localCursorRef = useRef<CursorState | null>(null)
  const initializedRef = useRef(false)
  const pendingLeaveRef = useRef<Promise<void>>(Promise.resolve())
  const shellRef = useRef<HTMLDivElement>(null)
  const ownLabelRef = useRef<HTMLDivElement>(null)
  const ownCursorImages = useScaledCursors(player?.slot)

  const flipped = useMemo(() => new Set(board?.flipped ?? []), [board])
  const sortedPlayers = useMemo(
    () => [...players].sort((a, b) => a.slot - b.slot),
    [players],
  )

  const refreshRoomData = useCallback(async (activeRoom: Room, activePlayer: Player) => {
    if (!supabase) return
    const [newPlayers, newBoard, newMessages] = await Promise.all([
      getPlayers(supabase, activeRoom.id),
      getTeamBoard(supabase, activeRoom.id, activePlayer.team),
      getTeamMessages(supabase, activeRoom.id, activePlayer.team),
    ])
    setPlayers(newPlayers)
    setBoard(newBoard)
    setMessages(newMessages)
  }, [])

  const enterRoom = useCallback(
    async (activeRoom: Room) => {
      if (!supabase || !userId) return
      const newPlayers = await getPlayers(supabase, activeRoom.id)
      const me = newPlayers.find((candidate) => candidate.user_id === userId)
      if (!me) throw new Error('El usuario no tiene un puesto en esta sala.')
      setRoom(activeRoom)
      setPlayer(me)
      setPlayers(newPlayers)
      await refreshRoomData(activeRoom, me)
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
    if (!userId || !supabase || initializedRef.current) return
    const codeFromUrl = new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase()
    if (!codeFromUrl) return
    initializedRef.current = true

    ;(async () => {
      try {
        const existingRoom = await getRoomByCode(supabase, codeFromUrl)
        if (!existingRoom) return
        await enterRoom(existingRoom)
      } catch (caught) {
        setError(errorText(caught))
      }
    })()
  }, [enterRoom, userId])

  useEffect(() => {
    if (!room || !player || !supabase) return
    const client = supabase

    let alive = true
    const channel = client
      .channel(`room-db-${room.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${room.id}` },
        async () => {
          if (!alive) return
          const updated = await getPlayers(client, room.id)
          if (alive) setPlayers(updated)
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'team_boards', filter: `room_id=eq.${room.id}` },
        (payload) => {
          const incoming = payload.new as TeamBoard
          if (incoming.team === player.team) setBoard(incoming)
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${room.id}` },
        (payload) => {
          const incoming = payload.new as ChatMessage
          if (incoming.team !== player.team) return
          setMessages((current) => (current.some((message) => message.id === incoming.id) ? current : [...current, incoming]))
          if (incoming.user_id !== player.user_id && !chatMutedRef.current) playChatSound()
        },
      )
      .subscribe()

    setSystemEntries([systemEntry('self', 'Has entrado en la sala')])

    // Presence marca quién está conectado de verdad: salir, cerrar la pestaña o perder la conexión lo quita.
    let knownOnline = new Map<string, string>()
    let firstSync = true

    const cursorChannel = client
      .channel(`room-cursors-${room.id}`, { config: { broadcast: { self: true }, presence: { key: player.user_id } } })
      .on('broadcast', { event: 'cursor' }, ({ payload }) => {
        const cursor = payload as CursorState
        if (!cursor?.userId || cursor.userId === player.user_id) return
        setCursorStates((current) => ({ ...current, [cursor.userId]: cursor }))
      })
      .on('presence', { event: 'sync' }, () => {
        const state = cursorChannel.presenceState<PresenceMeta>()
        const online = new Map<string, string>()
        for (const [key, metas] of Object.entries(state)) online.set(key, metas[0]?.display_name ?? 'Jugador')

        const entries: ChatEntry[] = []
        for (const [id, displayName] of online) {
          if (id === player.user_id || knownOnline.has(id)) continue
          entries.push(firstSync
            ? systemEntry('info', `${displayName} está en la sala`)
            : systemEntry('join', `${displayName} ha entrado en la sala`))
        }
        for (const [id, displayName] of knownOnline) {
          if (id !== player.user_id && !online.has(id)) entries.push(systemEntry('leave', `${displayName} ha salido de la sala`))
        }

        knownOnline = online
        firstSync = false
        setOnlineIds(new Set(online.keys()))
        if (entries.length) setSystemEntries((current) => [...current, ...entries])
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          void cursorChannel.track({ user_id: player.user_id, display_name: player.display_name } satisfies PresenceMeta)
          sendCursor(cursorChannelRef.current ?? cursorChannel, false, true)
        }
      })

    cursorChannelRef.current = cursorChannel

    return () => {
      alive = false
      void client.removeChannel(channel)
      void client.removeChannel(cursorChannel)
      cursorChannelRef.current = null
    }
    // The callback is intentionally kept stable through refs/state below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, player])

  useEffect(() => {
    if (!room || !player) return
    const defaults: Record<string, CursorState> = {}
    for (const slot of SLOTS) {
      const rosterPlayer = players.find((candidate) => candidate.slot === slot)
      const position = CURSOR_ANCHORS[slot]
      if (rosterPlayer) {
        defaults[rosterPlayer.user_id] = {
          userId: rosterPlayer.user_id,
          team: rosterPlayer.team,
          slot: rosterPlayer.slot,
          displayName: rosterPlayer.display_name,
          x: position.x,
          y: position.y,
          down: false,
          ts: Date.now(),
        }
      }
    }
    setCursorStates((current) => ({ ...defaults, ...current }))
  }, [player, players, room])

  const sendCursor = useCallback(
    async (channel: RealtimeChannel | null, down: boolean, force = false) => {
      if (!channel || !room || !player) return
      const now = performance.now()
      if (!force && now - lastCursorSentRef.current < 35) return
      lastCursorSentRef.current = now
      const state = localCursorRef.current ?? {
        userId: player.user_id,
        team: player.team,
        slot: player.slot,
        displayName: player.display_name,
        x: CURSOR_ANCHORS[player.slot].x,
        y: CURSOR_ANCHORS[player.slot].y,
        down: false,
        ts: Date.now(),
      }
      const payload: CursorState = { ...state, down, ts: Date.now() }
      localCursorRef.current = payload
      await channel.send({ type: 'broadcast', event: 'cursor', payload })
    },
    [player, room],
  )

  useEffect(() => {
    if (!room || !player) return
    const move = (event: PointerEvent) => {
      const state: CursorState = {
        userId: player.user_id,
        team: player.team,
        slot: player.slot,
        displayName: player.display_name,
        x: Math.max(0, Math.min(1, event.clientX / window.innerWidth)),
        y: Math.max(0, Math.min(1, event.clientY / window.innerHeight)),
        down: currentDownRef.current,
        ts: Date.now(),
      }
      localCursorRef.current = state
      // El cursor propio es el nativo del sistema; aquí solo se mueve la etiqueta, sin pasar por React.
      const label = ownLabelRef.current
      if (label) {
        label.style.transform = `translate3d(${event.clientX + OWN_LABEL_OFFSET.x}px, ${event.clientY + OWN_LABEL_OFFSET.y}px, 0)`
        label.style.opacity = '1'
      }
      const now = performance.now()
      if (now - lastCursorSentRef.current < 35) return
      lastCursorSentRef.current = now
      void cursorChannelRef.current?.send({ type: 'broadcast', event: 'cursor', payload: state })
    }
    const down = () => {
      currentDownRef.current = true
      shellRef.current?.classList.add('pointer-down')
      void sendCursor(cursorChannelRef.current, true, true)
    }
    const up = () => {
      currentDownRef.current = false
      shellRef.current?.classList.remove('pointer-down')
      void sendCursor(cursorChannelRef.current, false, true)
    }
    const hideLabel = () => {
      if (ownLabelRef.current) ownLabelRef.current.style.opacity = '0'
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('blur', up)
    document.documentElement.addEventListener('pointerleave', hideLabel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('blur', up)
      document.documentElement.removeEventListener('pointerleave', hideLabel)
    }
  }, [room, player, sendCursor])

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

  async function handleFlip(character: string) {
    if (!supabase || !room || !player) return
    setError('')
    try {
      const updated = await toggleCard(supabase, room.id, player.team, character)
      if (updated) setBoard(updated)
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  async function handleReset() {
    if (!supabase || !room || !player) return
    setBusy(true)
    try {
      const updated = await resetTeamBoard(supabase, room.id, player.team)
      if (updated) setBoard(updated)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function handleSendChat(event: FormEvent) {
    event.preventDefault()
    const body = chatInput.trim()
    if (!supabase || !room || !player || !body) return
    setChatInput('')
    const { error: insertError } = await supabase.from('messages').insert({
      room_id: room.id,
      team: player.team,
      user_id: player.user_id,
      display_name: player.display_name,
      body: body.slice(0, 280),
    })
    if (insertError) setError(errorText(insertError))
  }

  function leaveRoom() {
    if (supabase && room) {
      // Libera el puesto para poder volver a entrar en cualquier equipo.
      pendingLeaveRef.current = leaveRoomRpc(supabase, room.id).catch((caught) => setError(errorText(caught)))
      setJoinCode(room.code)
    }
    setLookup(null)
    setRoom(null)
    setPlayer(null)
    setPlayers([])
    setBoard(null)
    setMessages([])
    setSystemEntries([])
    setOnlineIds(new Set())
    setCursorStates({})
    setNotice('')
    const params = new URLSearchParams(window.location.search)
    params.delete('room')
    window.history.replaceState({}, '', params.size ? `${window.location.pathname}?${params}` : window.location.pathname)
  }

  const setupWarning = characters.length < 24
  const isOnline = (id: string) => id === player?.user_id || onlineIds.has(id)
  const onlinePlayers = sortedPlayers.filter((candidate) => isOnline(candidate.user_id))
  const onlineCount = onlinePlayers.length
  const chatEntries = useMemo(
    () =>
      [...messages.map((message): ChatEntry => ({ kind: 'chat', ...message })), ...systemEntries]
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    [messages, systemEntries],
  )

  if (!isSupabaseConfigured) {
    return <SetupScreen />
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

  const remoteCursors = Object.values(cursorStates).filter(
    (cursor) => cursor.userId !== player.user_id && cursor.team === player.team && isOnline(cursor.userId),
  )
  const ownCursorStyle = ownCursorImages
    ? ({ '--own-cursor': cursorCss(ownCursorImages.up), '--own-cursor-down': cursorCss(ownCursorImages.down) } as CSSProperties)
    : undefined

  return (
    <div
      ref={shellRef}
      className={`app-shell game-shell ${TEAM_COLORS[player.team]} ${ownCursorImages ? 'own-cursor' : ''}`}
      style={ownCursorStyle}
    >
      {/* El equipo rojo ve la misma distribución en espejo (ver .game-shell.red en styles.css). */}
      <aside className="side-column">
        <header className={`game-toolbar ${TEAM_COLORS[player.team]}`}>
          <h1>{TEAM_NAMES[player.team]}</h1>
          <div className="toolbar-meta">
            Sala <strong>{room.code}</strong> · {onlineCount}/4 jugadores · Tú: {player.display_name}
          </div>
        </header>
        <div className={`toolbar-actions ${TEAM_COLORS[player.team]}`}>
          <button className="ghost-button" onClick={handleReset} disabled={busy}>
            Reiniciar mis fichas
          </button>
          <button className="danger-button" onClick={leaveRoom}>
            Salir
          </button>
        </div>
        <div className="side-cams">
          <CameraSlot label="CAM 1" player={onlinePlayers.find((candidate) => candidate.slot === 1)} />
          <CameraSlot label="CAM 2" player={onlinePlayers.find((candidate) => candidate.slot === 2)} />
        </div>
      </aside>

      <div className="main-column">
        <div className="top-stage">
          <TeamChat
            team={player.team}
            entries={chatEntries}
            muted={chatMuted}
            onToggleMute={() => setChatMuted((current) => !current)}
            input={chatInput}
            setInput={setChatInput}
            onSubmit={handleSendChat}
          />
          <div className="top-cams">
            <CameraSlot label="CAM 3" player={onlinePlayers.find((candidate) => candidate.slot === 3)} />
            <CameraSlot label="CAM 4" player={onlinePlayers.find((candidate) => candidate.slot === 4)} />
          </div>
        </div>

        <main className="board-wrap">
          <section className="board-grid" aria-label="Personajes">
            {room.characters.map((character) => (
              <CharacterCard
                key={character}
                character={character}
                isDown={flipped.has(character)}
                onToggle={handleFlip}
              />
            ))}
          </section>
        </main>
      </div>

      {notice && <div className="toast notice in-game">{notice}</div>}
      {error && <div className="toast error in-game">{error}</div>}

      <div className="cursor-layer" aria-hidden="true">
        {remoteCursors.map((cursor) => (
          <RemoteCursor key={cursor.userId} cursor={cursor} />
        ))}
        <div ref={ownLabelRef} className={`own-cursor-label ${TEAM_COLORS[player.team]}`}>
          {player.display_name}
        </div>
      </div>

      <div className="mobile-room-chip">Sala {room.code}</div>
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

function CameraSlot({ label, player }: { label: string; player?: Player }) {
  return (
    <div className="camera-slot">
      <div className="camera-label">{label}</div>
      <div className="camera-placeholder">{player ? player.display_name : 'ESPERANDO JUGADOR'}</div>
    </div>
  )
}

function TeamChat({
  team,
  entries,
  muted,
  onToggleMute,
  input,
  setInput,
  onSubmit,
}: {
  team: Team
  entries: ChatEntry[]
  muted: boolean
  onToggleMute: () => void
  input: string
  setInput: (value: string) => void
  onSubmit: (event: FormEvent) => void
}) {
  const messagesRef = useRef<HTMLDivElement>(null)
  const hasChat = entries.some((entry) => entry.kind === 'chat')

  useEffect(() => {
    const list = messagesRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [entries])

  return (
    <section className={`team-chat ${TEAM_COLORS[team]}`}>
      <div className="chat-header">
        <span>CHAT · {TEAM_NAMES[team]}</span>
        <button
          type="button"
          className="mute-button"
          onClick={onToggleMute}
          aria-pressed={muted}
          aria-label={muted ? 'Activar sonido del chat' : 'Silenciar chat'}
          title={muted ? 'Activar sonido del chat' : 'Silenciar chat'}
        >
          {muted ? '🔕' : '🔔'}
        </button>
      </div>
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
    </section>
  )
}

function CharacterCard({
  character,
  isDown,
  onToggle,
}: {
  character: string
  isDown: boolean
  onToggle: (character: string) => void
}) {
  // La longitud del nombre reduce el tamaño de letra para que quepa en una sola línea (ficha y etiqueta de bajada).
  return (
    <button
      className={`character-card ${isDown ? 'is-down' : ''}`}
      onClick={() => onToggle(character)}
      aria-pressed={isDown}
      data-name={character}
      style={{ '--name-len': Math.max(character.length, 5) } as CSSProperties}
    >
      <div className="character-face">
        <div className="card-frame">
          <div className="portrait-frame">
            <img src={`${import.meta.env.BASE_URL}characters/${encodeURIComponent(character)}.png`} alt={character} loading="lazy" />
          </div>
          <div className="character-name">{character}</div>
        </div>
      </div>
    </button>
  )
}

function RemoteCursor({ cursor }: { cursor: CursorState }) {
  return (
    <div
      className={`remote-cursor ${cursor.down ? 'down' : ''} ${TEAM_COLORS[cursor.team]}`}
      style={{ left: `${cursor.x * 100}vw`, top: `${cursor.y * 100}vh` }}
    >
      <img
        src={getSlotCursorFile(cursor.slot, cursor.down)}
        alt=""
        onError={(event) => {
          event.currentTarget.style.display = 'none'
        }}
      />
      <div className="cursor-fallback">↖</div>
      <span>{cursor.displayName}</span>
    </div>
  )
}

export default App
