export type Team = 1 | 2

export type Slot = 1 | 2 | 3 | 4

export type Player = {
  room_id: string
  user_id: string
  team: Team
  slot: Slot
  display_name: string
  joined_at: string
}

export type Room = {
  id: string
  code: string
  characters: string[]
  created_by: string
  created_at: string
}

export type TeamBoard = {
  room_id: string
  team: Team
  flipped: string[]
  updated_at: string
}

export type ChatMessage = {
  id: number
  room_id: string
  team: Team
  user_id: string
  display_name: string
  body: string
  created_at: string
}

export type CursorState = {
  userId: string
  team: Team
  slot: Slot
  displayName: string
  x: number
  y: number
  down: boolean
  ts: number
}
