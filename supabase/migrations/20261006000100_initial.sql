-- Overwatch ¿Quién es Quién? - Supabase schema
-- Ejecuta este archivo completo en Supabase > SQL Editor.
-- Después activa Authentication > Providers > Anonymous Sign-Ins.

create extension if not exists pgcrypto;

drop table if exists public.messages cascade;
drop table if exists public.team_boards cascade;
drop table if exists public.room_players cascade;
drop table if exists public.rooms cascade;

drop function if exists public.is_room_member(uuid);
drop function if exists public.member_team(uuid);
drop function if exists public.create_room(text, jsonb, text, smallint, smallint);
drop function if exists public.join_room(text, text, smallint, smallint);
drop function if exists public.toggle_card(uuid, smallint, text);
drop function if exists public.reset_team_board(uuid, smallint);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{5}$'),
  characters jsonb not null check (jsonb_typeof(characters) = 'array'),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.room_players (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  team smallint not null check (team in (1, 2)),
  slot smallint not null check (slot in (1, 2, 3, 4)),
  display_name text not null check (char_length(display_name) between 1 and 24),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),
  unique (room_id, slot)
);

create table public.team_boards (
  room_id uuid not null references public.rooms(id) on delete cascade,
  team smallint not null check (team in (1, 2)),
  flipped text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (room_id, team)
);

create table public.messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  team smallint not null check (team in (1, 2)),
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 24),
  body text not null check (char_length(body) between 1 and 280),
  created_at timestamptz not null default now()
);

create index messages_room_team_created_idx on public.messages(room_id, team, created_at);
create index room_players_room_idx on public.room_players(room_id);

create or replace function public.is_room_member(_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.room_players
    where room_id = _room_id and user_id = auth.uid()
  );
$$;

create or replace function public.member_team(_room_id uuid)
returns smallint
language sql
stable
security definer
set search_path = public
as $$
  select team
  from public.room_players
  where room_id = _room_id and user_id = auth.uid()
  limit 1;
$$;

create or replace function public.create_room(
  p_code text,
  p_characters jsonb,
  p_display_name text,
  p_team smallint default 1,
  p_slot smallint default 1
)
returns table(room_id uuid, code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  uid uuid := auth.uid();
  clean_name text := left(trim(coalesce(p_display_name, 'Jugador 1')), 24);
begin
  if uid is null then raise exception 'No hay sesión de jugador.'; end if;
  if p_team not in (1, 2) or p_slot not in (1, 2, 3, 4) then raise exception 'Equipo/slot inválido.'; end if;
  if (p_team = 1 and p_slot not in (1, 2)) or (p_team = 2 and p_slot not in (3, 4)) then
    raise exception 'Los slots 1-2 pertenecen al Equipo Azul y los slots 3-4 al Equipo Rojo.';
  end if;
  if jsonb_array_length(p_characters) <> 24 then raise exception 'La partida necesita exactamente 24 personajes.'; end if;
  if clean_name = '' then clean_name := 'Jugador 1'; end if;

  insert into public.rooms(code, characters, created_by)
  values (upper(trim(p_code)), p_characters, uid)
  returning id into new_id;

  insert into public.team_boards(room_id, team)
  values (new_id, 1), (new_id, 2);

  insert into public.room_players(room_id, user_id, team, slot, display_name)
  values (new_id, uid, p_team, p_slot, clean_name);

  return query select new_id, upper(trim(p_code));
end;
$$;

create or replace function public.join_room(
  p_code text,
  p_display_name text,
  p_team smallint,
  p_slot smallint
)
returns table(room_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid;
  uid uuid := auth.uid();
  clean_name text := left(trim(coalesce(p_display_name, 'Jugador')), 24);
  existing_room uuid;
begin
  if uid is null then raise exception 'No hay sesión de jugador.'; end if;
  if p_team not in (1, 2) or p_slot not in (1, 2, 3, 4) then raise exception 'Equipo/slot inválido.'; end if;
  if (p_team = 1 and p_slot not in (1, 2)) or (p_team = 2 and p_slot not in (3, 4)) then
    raise exception 'Los slots 1-2 pertenecen al Equipo Azul y los slots 3-4 al Equipo Rojo.';
  end if;
  if clean_name = '' then clean_name := 'Jugador'; end if;

  select id into target_id from public.rooms where code = upper(trim(p_code));
  if target_id is null then raise exception 'Sala no encontrada.'; end if;

  select room_id into existing_room
  from public.room_players
  where room_id = target_id and user_id = uid
  limit 1;

  if existing_room is not null then
    update public.room_players
      set display_name = clean_name
      where room_id = target_id and user_id = uid;
    return query select target_id;
    return;
  end if;

  perform 1 from public.room_players
    where room_id = target_id and slot = p_slot
    for update;

  if exists (select 1 from public.room_players where room_id = target_id and slot = p_slot) then
    raise exception 'Ese puesto ya está ocupado.';
  end if;

  insert into public.room_players(room_id, user_id, team, slot, display_name)
  values (target_id, uid, p_team, p_slot, clean_name);

  return query select target_id;
end;
$$;

create or replace function public.toggle_card(
  p_room_id uuid,
  p_team smallint,
  p_character text
)
returns setof public.team_boards
language plpgsql
security definer
set search_path = public
as $$
declare
  current_board public.team_boards%rowtype;
  new_flipped text[];
begin
  if auth.uid() is null or public.member_team(p_room_id) <> p_team then
    raise exception 'No tienes permiso para modificar este tablero.';
  end if;

  select * into current_board
  from public.team_boards
  where room_id = p_room_id and team = p_team
  for update;

  if current_board.room_id is null then
    raise exception 'Tablero no encontrado.';
  end if;

  if p_character = any(current_board.flipped) then
    new_flipped := array_remove(current_board.flipped, p_character);
  else
    new_flipped := array_append(current_board.flipped, p_character);
  end if;

  update public.team_boards
    set flipped = new_flipped, updated_at = now()
    where room_id = p_room_id and team = p_team
    returning * into current_board;

  return next current_board;
end;
$$;

create or replace function public.reset_team_board(
  p_room_id uuid,
  p_team smallint
)
returns setof public.team_boards
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.team_boards%rowtype;
begin
  if auth.uid() is null or public.member_team(p_room_id) <> p_team then
    raise exception 'No tienes permiso para reiniciar este tablero.';
  end if;

  update public.team_boards
    set flipped = '{}', updated_at = now()
    where room_id = p_room_id and team = p_team
    returning * into updated;

  if updated.room_id is null then raise exception 'Tablero no encontrado.'; end if;
  return next updated;
end;
$$;

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.team_boards enable row level security;
alter table public.messages enable row level security;

create policy "Members can read their room"
on public.rooms for select
to authenticated
using (public.is_room_member(id));

create policy "Members can read room players"
on public.room_players for select
to authenticated
using (public.is_room_member(room_id));

create policy "Members can read their team board"
on public.team_boards for select
to authenticated
using (public.member_team(room_id) = team);

create policy "Members can read their team chat"
on public.messages for select
to authenticated
using (public.member_team(room_id) = team);

create policy "Members can send to their team chat"
on public.messages for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.member_team(room_id) = team
);

grant usage on schema public to authenticated;
grant select on public.rooms, public.room_players, public.team_boards, public.messages to authenticated;
grant insert on public.messages to authenticated;
grant usage, select on sequence public.messages_id_seq to authenticated;
grant execute on function public.create_room(text, jsonb, text, smallint, smallint) to authenticated;
grant execute on function public.join_room(text, text, smallint, smallint) to authenticated;
grant execute on function public.toggle_card(uuid, smallint, text) to authenticated;
grant execute on function public.reset_team_board(uuid, smallint) to authenticated;
grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.member_team(uuid) to authenticated;

alter publication supabase_realtime add table public.room_players;
alter publication supabase_realtime add table public.team_boards;
alter publication supabase_realtime add table public.messages;
