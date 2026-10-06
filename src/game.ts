import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage, Player, Room, Team, TeamBoard, Slot } from './types'

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function makeRoomCode(length = 5) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('')
}

export function shuffle<T>(items: T[]) {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1)
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export function pick24(characters: string[]) {
  if (characters.length < 24) {
    throw new Error(`Necesitas al menos 24 personajes PNG. Ahora mismo hay ${characters.length}.`)
  }
  return shuffle(characters).slice(0, 24)
}

export async function createRoom(
  supabase: SupabaseClient,
  characters: string[],
  displayName: string,
  userId: string,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = makeRoomCode()
    const chosen = pick24(characters)
    const { data, error } = await supabase.rpc('create_room', {
      p_code: code,
      p_characters: chosen,
      p_display_name: displayName.trim().slice(0, 24) || 'Jugador 1',
      p_team: 1,
      p_slot: 1,
    })

    if (!error && data?.[0]) {
      const row = data[0] as { room_id: string; code: string }
      const room = await getRoomById(supabase, row.room_id)
      if (!room) throw new Error('La sala se creó pero no se pudo leer.')
      return room
    }
    if (error && !/duplicate|unique/i.test(error.message)) throw error
  }
  throw new Error('No se pudo generar un código de sala único. Inténtalo de nuevo.')
}

export type RoomOccupant = { team: Team; slot: Slot; display_name: string; is_me: boolean }

export async function getRoomAvailability(supabase: SupabaseClient, code: string) {
  const { data, error } = await supabase.rpc('room_availability', { p_code: code.trim().toUpperCase() })
  if (error) throw error
  return (data ?? []) as RoomOccupant[]
}

export async function joinTeam(supabase: SupabaseClient, code: string, team: Team, displayName: string) {
  const { data, error } = await supabase.rpc('join_team', {
    p_code: code.trim().toUpperCase(),
    p_display_name: displayName.trim().slice(0, 24) || 'Jugador',
    p_team: team,
  })
  if (error) throw error
  if (!data?.[0]) throw new Error('No se pudo entrar en la sala.')
  const room = await getRoomById(supabase, (data[0] as { room_id: string }).room_id)
  if (!room) throw new Error('Sala no encontrada.')
  return room
}

export async function leaveRoom(supabase: SupabaseClient, roomId: string) {
  const { error } = await supabase.rpc('leave_room', { p_room_id: roomId })
  if (error) throw error
}

export async function getRoomByCode(supabase: SupabaseClient, code: string) {
  const { data, error } = await supabase.from('rooms').select('*').eq('code', code.toUpperCase()).maybeSingle()
  if (error) throw error
  return data as Room | null
}

export async function getRoomById(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase.from('rooms').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data as Room | null
}

export async function getPlayers(supabase: SupabaseClient, roomId: string) {
  const { data, error } = await supabase
    .from('room_players')
    .select('*')
    .eq('room_id', roomId)
    .order('slot', { ascending: true })
  if (error) throw error
  return (data ?? []) as Player[]
}

export async function getTeamBoard(supabase: SupabaseClient, roomId: string, team: Team) {
  const { data, error } = await supabase
    .from('team_boards')
    .select('*')
    .eq('room_id', roomId)
    .eq('team', team)
    .maybeSingle()
  if (error) throw error
  return (data as TeamBoard | null) ?? { room_id: roomId, team, flipped: [], updated_at: new Date().toISOString() }
}

export async function getTeamMessages(supabase: SupabaseClient, roomId: string, team: Team) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('room_id', roomId)
    .eq('team', team)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) throw error
  return (data ?? []) as ChatMessage[]
}

export async function toggleCard(supabase: SupabaseClient, roomId: string, team: Team, character: string) {
  const { data, error } = await supabase.rpc('toggle_card', {
    p_room_id: roomId,
    p_team: team,
    p_character: character,
  })
  if (error) throw error
  return (data?.[0] as TeamBoard | undefined) ?? null
}

export async function resetTeamBoard(supabase: SupabaseClient, roomId: string, team: Team) {
  const { data, error } = await supabase.rpc('reset_team_board', {
    p_room_id: roomId,
    p_team: team,
  })
  if (error) throw error
  return (data?.[0] as TeamBoard | undefined) ?? null
}
