import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const isSupabaseConfigured = Boolean(url && key)

export const supabase = isSupabaseConfigured
  ? createClient(url!, key!, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null

// Último token de sesión, legible de forma síncrona al cerrar la pestaña (ver leaveRoomOnUnload).
let accessToken = ''
supabase?.auth.onAuthStateChange((_event, session) => {
  accessToken = session?.access_token ?? ''
})

// Al cerrar o recargar la pestaña no da tiempo a esperar a supabase-js: se libera el puesto con una
// petición keepalive, que el navegador termina de enviar aunque la página ya se haya cerrado.
export function leaveRoomOnUnload(roomId: string) {
  if (!url || !key || !accessToken) return
  try {
    void fetch(`${url}/rest/v1/rpc/leave_room`, {
      method: 'POST',
      keepalive: true,
      headers: { apikey: key, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_room_id: roomId }),
    })
  } catch {
    // Si no sale, el puesto se libera solo al dejar de recibir latidos (room_sync).
  }
}

export async function ensureAnonymousSession() {
  if (!supabase) throw new Error('Supabase no está configurado.')

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) throw sessionError
  if (sessionData.session?.user) return sessionData.session.user

  const { data, error } = await supabase.auth.signInAnonymously()
  if (error) throw error
  if (!data.user) throw new Error('No se pudo crear el usuario anónimo.')
  return data.user
}
