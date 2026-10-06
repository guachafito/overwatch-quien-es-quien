import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { ensureAnonymousSession, isSupabaseConfigured, supabase } from './supabase'
import {
  createRoom,
  getPlayers,
  getRoomByCode,
  getTeamBoard,
  getTeamMessages,
  joinRoom,
  resetTeamBoard,
  toggleCard,
} from './game'
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
  const [chatMuted, setChatMuted] = useState(readChatMuted)
  const chatMutedRef = useRef(chatMuted)
  const [name, setName] = useState('')
  const [joinCode, setJoinCode] = useState(new URLSearchParams(window.location.search).get('room') ?? '')
  const [joinTeam, setJoinTeam] = useState<Team>(2)
  const [joinSlot, setJoinSlot] = useState<Slot>(3)
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

    const cursorChannel = client
      .channel(`room-cursors-${room.id}`, { config: { broadcast: { self: true } } })
      .on('broadcast', { event: 'cursor' }, ({ payload }) => {
        const cursor = payload as CursorState
        if (!cursor?.userId) return
        setCursorStates((current) => ({ ...current, [cursor.userId]: cursor }))
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
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
      setCursorStates((current) => ({ ...current, [player.user_id]: payload }))
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
      setCursorStates((current) => ({ ...current, [player.user_id]: state }))
      const now = performance.now()
      if (now - lastCursorSentRef.current < 35) return
      lastCursorSentRef.current = now
      void cursorChannelRef.current?.send({ type: 'broadcast', event: 'cursor', payload: state })
    }
    const down = () => {
      currentDownRef.current = true
      void sendCursor(cursorChannelRef.current, true, true)
    }
    const up = () => {
      currentDownRef.current = false
      void sendCursor(cursorChannelRef.current, false, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('blur', up)
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

  function handleTeamChange(nextTeam: Team) {
    setJoinTeam(nextTeam)
    setJoinSlot(nextTeam === 1 ? 1 : 3)
  }

  async function handleJoin(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return setError('No se ha inicializado la conexión con Supabase.')
    setBusy(true)
    setError('')
    try {
      const joinedRoom = await joinRoom(supabase, joinCode, joinTeam, joinSlot, name)
      await enterRoom(joinedRoom)
      setNotice(`Has entrado en ${joinedRoom.code}.`)
    } catch (caught) {
      setError(errorText(caught))
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
    setRoom(null)
    setPlayer(null)
    setPlayers([])
    setBoard(null)
    setMessages([])
    setCursorStates({})
    setNotice('')
    const params = new URLSearchParams(window.location.search)
    params.delete('room')
    window.history.replaceState({}, '', params.size ? `${window.location.pathname}?${params}` : window.location.pathname)
  }

  const setupWarning = characters.length < 24
  const onlineCount = players.length

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
        setJoinCode={setJoinCode}
        joinTeam={joinTeam}
        setJoinTeam={handleTeamChange}
        joinSlot={joinSlot}
        setJoinSlot={setJoinSlot}
        busy={busy}
        error={error}
        notice={notice}
        onCreate={handleCreate}
        onJoin={handleJoin}
      />
    )
  }

  const ownCursor = cursorStates[player.user_id]
  const allCursors = Object.values(cursorStates).filter((cursor) => cursor.team === player.team)

  return (
    <div className="app-shell game-shell">
      <div className="top-stage">
        <div className="cam-side cam-side-left">
          <CameraSlot label="CAM 1" player={sortedPlayers.find((candidate) => candidate.slot === 1)} />
          <CameraSlot label="CAM 2" player={sortedPlayers.find((candidate) => candidate.slot === 2)} />
        </div>
        <TeamChat
          team={player.team}
          messages={messages}
          muted={chatMuted}
          onToggleMute={() => setChatMuted((current) => !current)}
          input={chatInput}
          setInput={setChatInput}
          onSubmit={handleSendChat}
        />
        <div className="cam-side cam-side-right">
          <CameraSlot label="CAM 3" player={sortedPlayers.find((candidate) => candidate.slot === 3)} />
          <CameraSlot label="CAM 4" player={sortedPlayers.find((candidate) => candidate.slot === 4)} />
        </div>
      </div>

      <header className={`game-toolbar ${TEAM_COLORS[player.team]}`}>
        <div>
          <h1>{TEAM_NAMES[player.team]}</h1>
          <div className="toolbar-meta">
            Sala <strong>{room.code}</strong> · {onlineCount}/4 jugadores · Tú: {player.display_name}
          </div>
        </div>
        <div className="toolbar-actions">
          <button className="ghost-button" onClick={handleReset} disabled={busy}>
            Reiniciar mis fichas
          </button>
          <button className="danger-button" onClick={leaveRoom}>
            Salir
          </button>
        </div>
      </header>

      {notice && <div className="toast notice in-game">{notice}</div>}
      {error && <div className="toast error in-game">{error}</div>}

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

      <div className="cursor-layer" aria-hidden="true">
        {allCursors.map((cursor) => (
          <RemoteCursor key={cursor.userId} cursor={cursor} isOwn={cursor.userId === userId} />
        ))}
        {ownCursor && !allCursors.some((cursor) => cursor.userId === ownCursor.userId) && (
          <RemoteCursor key="own-fallback" cursor={ownCursor} isOwn />
        )}
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
  joinTeam: Team
  setJoinTeam: (value: Team) => void
  joinSlot: Slot
  setJoinSlot: (value: Slot) => void
  busy: boolean
  error: string
  notice: string
  onCreate: (event: FormEvent) => void
  onJoin: (event: FormEvent) => void
}) {
  const occupiedHint = props.joinCode.trim() ? 'El puesto se valida al entrar en la sala.' : 'Primero escribe el código de la sala.'

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

        <form className="panel" onSubmit={props.onJoin}>
          <span className="panel-label">JUGADOR</span>
          <h2>Unirse a una partida</h2>
          <label>
            Código de sala
            <input value={props.joinCode} onChange={(event) => props.setJoinCode(event.target.value.toUpperCase())} maxLength={5} placeholder="ABCDE" />
          </label>
          <label>
            Tu nombre
            <input value={props.name} onChange={(event) => props.setName(event.target.value)} maxLength={24} placeholder="Jugador 2" />
          </label>
          <div className="two-fields">
            <label>
              Equipo
              <select value={props.joinTeam} onChange={(event) => props.setJoinTeam(Number(event.target.value) as Team)}>
                <option value={1}>Equipo Azul</option>
                <option value={2}>Equipo Rojo</option>
              </select>
            </label>
            <label>
              Puesto
              <select value={props.joinSlot} onChange={(event) => props.setJoinSlot(Number(event.target.value) as Slot)}>
                {props.joinTeam === 1 ? (
                  <>
                    <option value={1}>Jugador 1</option>
                    <option value={2}>Jugador 2</option>
                  </>
                ) : (
                  <>
                    <option value={3}>Jugador 3</option>
                    <option value={4}>Jugador 4</option>
                  </>
                )}
              </select>
            </label>
          </div>
          <button className="primary-button" disabled={props.busy || !props.joinCode.trim() || !props.name.trim()}>
            {props.busy ? 'Entrando…' : 'Unirme'}
          </button>
          <small>{occupiedHint}</small>
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
  messages,
  muted,
  onToggleMute,
  input,
  setInput,
  onSubmit,
}: {
  team: Team
  messages: ChatMessage[]
  muted: boolean
  onToggleMute: () => void
  input: string
  setInput: (value: string) => void
  onSubmit: (event: FormEvent) => void
}) {
  const messagesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const list = messagesRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages])

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
        {messages.length === 0 ? (
          <div className="chat-empty">Escribe algo. Solo lo verá tu equipo.</div>
        ) : (
          messages.map((message) => (
            <div className="chat-message" key={message.id}>
              <strong>{message.display_name}</strong>
              <span>{message.body}</span>
            </div>
          ))
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
  return (
    <button className={`character-card ${isDown ? 'is-down' : ''}`} onClick={() => onToggle(character)} aria-pressed={isDown}>
      <div className="character-face">
        <div className="portrait-frame">
          <img src={`${import.meta.env.BASE_URL}characters/${encodeURIComponent(character)}.png`} alt={character} loading="lazy" />
          <span className="role-dot" />
        </div>
        <div className="character-name">{character}</div>
        <div className="fold-marker">▾</div>
      </div>
    </button>
  )
}

function RemoteCursor({ cursor, isOwn }: { cursor: CursorState; isOwn: boolean }) {
  return (
    <div
      className={`remote-cursor ${isOwn ? 'own' : ''} ${cursor.down ? 'down' : ''} ${TEAM_COLORS[cursor.team]}`}
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
