-- Vista de espectador para OBS: cada tablero de equipo tiene una clave secreta. Quien abre ?obs=<clave>
-- puede ver ese equipo (tablero, chat y jugadores) sin ocupar puesto ni poder modificar nada.

alter table public.team_boards
  add column if not exists spectator_key uuid not null default gen_random_uuid();

create unique index if not exists team_boards_spectator_key_idx on public.team_boards(spectator_key);

create table if not exists public.room_spectators (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  team smallint not null check (team in (1, 2)),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

-- Sin políticas: solo se accede a través de las funciones security definer de abajo.
alter table public.room_spectators enable row level security;

create or replace function public.spectator_team(_room_id uuid)
returns smallint
language sql
stable
security definer
set search_path = public
as $$
  select team
  from public.room_spectators
  where room_id = _room_id and user_id = auth.uid()
  limit 1;
$$;

create or replace function public.spectate_team(p_key uuid)
returns table(room_id uuid, team smallint)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
  target_room uuid;
  target_team smallint;
begin
  if uid is null then raise exception 'No hay sesión.'; end if;

  select tb.room_id, tb.team into target_room, target_team
  from public.team_boards tb
  where tb.spectator_key = p_key;
  if target_room is null then raise exception 'Enlace de espectador no válido.'; end if;

  insert into public.room_spectators(room_id, user_id, team)
  values (target_room, uid, target_team)
  on conflict (room_id, user_id) do update set team = excluded.team;

  return query select target_room, target_team;
end;
$$;

drop policy if exists "Members can read their room" on public.rooms;
create policy "Members can read their room"
on public.rooms for select
to authenticated
using (public.is_room_member(id) or public.spectator_team(id) is not null);

drop policy if exists "Members can read room players" on public.room_players;
create policy "Members can read room players"
on public.room_players for select
to authenticated
using (public.is_room_member(room_id) or public.spectator_team(room_id) is not null);

drop policy if exists "Members can read their team board" on public.team_boards;
create policy "Members can read their team board"
on public.team_boards for select
to authenticated
using (public.member_team(room_id) = team or public.spectator_team(room_id) = team);

drop policy if exists "Members can read their team chat" on public.messages;
create policy "Members can read their team chat"
on public.messages for select
to authenticated
using (public.member_team(room_id) = team or public.spectator_team(room_id) = team);

grant execute on function public.spectator_team(uuid) to authenticated;
grant execute on function public.spectate_team(uuid) to authenticated;
