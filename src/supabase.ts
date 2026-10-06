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
