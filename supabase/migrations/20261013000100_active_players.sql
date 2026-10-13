-- Jugadores activos y sincronización sin postgres_changes.
--
-- * Cada jugador con la pestaña abierta llama a room_sync cada pocos segundos (latido). Quien lleva más
--   de 2 minutos sin latido (pestaña cerrada sin avisar, caída…) se borra de room_players: su puesto
--   queda libre y su nick no se guarda. Al cerrar la pestaña normalmente el cliente ya llama a leave_room.
-- * room_sync devuelve en una sola consulta los jugadores activos, el tablero del equipo y el último
--   mensaje, para que jugadores y vistas OBS se corrijan solos aunque se pierda algún mensaje en tiempo real.
-- * Tablero y chat viajan ahora por broadcast de Realtime. Se quitan las tablas de la publicación
--   supabase_realtime: Realtime deja de leer y filtrar el WAL de la base de datos en cada cambio.

alter table public.room_players
  add column if not exists last_seen timestamptz not null default now();

-- Contador que solo crece: ordena los tableros que llegan por distintos caminos sin depender de relojes.
alter table public.team_boards
  add column if not exists version bigint not null default 0;

do $$
declare
  t text;
begin
  foreach t in array array['room_players', 'team_boards', 'messages'] loop
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
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
  if auth.uid() is null or public.member_team(p_room_id) is distinct from p_team then
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
    set flipped = new_flipped, updated_at = now(), version = version + 1
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
  if auth.uid() is null or public.member_team(p_room_id) is distinct from p_team then
    raise exception 'No tienes permiso para reiniciar este tablero.';
  end if;

  update public.team_boards
    set flipped = '{}', updated_at = now(), version = version + 1
    where room_id = p_room_id and team = p_team
    returning * into updated;

  if updated.room_id is null then raise exception 'Tablero no encontrado.'; end if;
  return next updated;
end;
$$;

-- Latido + estado de la sala. Los espectadores (OBS) solo leen; si quien llama ya no tiene puesto
-- (se le borró por inactividad) devuelve member = false para que el cliente vuelva a entrar.
create or replace function public.room_sync(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  my_team smallint;
begin
  if uid is null then raise exception 'No hay sesión.'; end if;

  update public.room_players rp
    set last_seen = now()
    where rp.room_id = p_room_id and rp.user_id = uid
    returning rp.team into my_team;

  if my_team is null then
    my_team := public.spectator_team(p_room_id);
    if my_team is null then return jsonb_build_object('member', false); end if;
  end if;

  delete from public.room_players rp
    where rp.room_id = p_room_id and rp.last_seen < now() - interval '2 minutes';

  return jsonb_build_object(
    'member', true,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', rp.user_id, 'team', rp.team, 'slot', rp.slot, 'display_name', rp.display_name
      ) order by rp.slot)
      from public.room_players rp
      where rp.room_id = p_room_id
    ), '[]'::jsonb),
    'board', (
      select jsonb_build_object('flipped', to_jsonb(tb.flipped), 'version', tb.version)
      from public.team_boards tb
      where tb.room_id = p_room_id and tb.team = my_team
    ),
    'last_message_id', (
      select max(m.id) from public.messages m where m.room_id = p_room_id and m.team = my_team
    ),
    -- Solo cuántas fichas tiene bajadas cada equipo (para el mini-tablero del rival), nunca cuáles.
    'down', (
      select jsonb_object_agg(tb.team::text, jsonb_build_object('down', coalesce(cardinality(tb.flipped), 0), 'v', tb.version))
      from public.team_boards tb
      where tb.room_id = p_room_id
    )
  );
end;
$$;

-- Los puestos de jugadores inactivos se muestran libres al elegir equipo.
create or replace function public.room_availability(p_code text)
returns table(team smallint, slot smallint, display_name text, is_me boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  target_id uuid;
begin
  if auth.uid() is null then raise exception 'No hay sesión de jugador.'; end if;

  select r.id into target_id from public.rooms r where r.code = upper(trim(p_code));
  if target_id is null then raise exception 'Sala no encontrada.'; end if;

  return query
    select rp.team, rp.slot, rp.display_name, rp.user_id = auth.uid()
    from public.room_players rp
    where rp.room_id = target_id
      and (rp.last_seen >= now() - interval '2 minutes' or rp.user_id = auth.uid())
    order by rp.slot;
end;
$$;

create or replace function public.join_team(
  p_code text,
  p_display_name text,
  p_team smallint
)
returns table(room_id uuid, slot smallint)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  target_id uuid;
  uid uuid := auth.uid();
  clean_name text := left(trim(coalesce(p_display_name, 'Jugador')), 24);
  current_team smallint;
  current_slot smallint;
  free_slot smallint;
begin
  if uid is null then raise exception 'No hay sesión de jugador.'; end if;
  if p_team not in (1, 2) then raise exception 'Equipo inválido.'; end if;
  if clean_name = '' then clean_name := 'Jugador'; end if;

  -- Bloquea la sala para que dos jugadores no se queden con el mismo puesto a la vez.
  select r.id into target_id from public.rooms r where r.code = upper(trim(p_code)) for update;
  if target_id is null then raise exception 'Sala no encontrada.'; end if;

  -- Libera los puestos de quien lleva tiempo sin latido.
  delete from public.room_players rp
    where rp.room_id = target_id and rp.user_id <> uid and rp.last_seen < now() - interval '2 minutes';

  select rp.team, rp.slot into current_team, current_slot
  from public.room_players rp
  where rp.room_id = target_id and rp.user_id = uid;

  if current_team = p_team then
    update public.room_players rp
      set display_name = clean_name, last_seen = now()
      where rp.room_id = target_id and rp.user_id = uid;
    return query select target_id, current_slot;
    return;
  end if;

  select s into free_slot
  from unnest(case when p_team = 1 then array[1, 2]::smallint[] else array[3, 4]::smallint[] end) as s
  where not exists (
    select 1 from public.room_players rp where rp.room_id = target_id and rp.slot = s
  )
  order by s
  limit 1;

  if free_slot is null then raise exception 'Ese equipo está completo.'; end if;

  if current_slot is not null then
    update public.room_players rp
      set team = p_team, slot = free_slot, display_name = clean_name, joined_at = now(), last_seen = now()
      where rp.room_id = target_id and rp.user_id = uid;
  else
    insert into public.room_players(room_id, user_id, team, slot, display_name)
    values (target_id, uid, p_team, free_slot, clean_name);
  end if;

  return query select target_id, free_slot;
end;
$$;

-- Limpieza: las salas sin jugadores durante más de un día se borran (con su tablero, chat y enlaces OBS)
-- al crear una sala nueva, para que no se acumulen.
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

  delete from public.rooms r
    where r.created_at < now() - interval '1 day'
      and not exists (
        select 1 from public.room_players rp
        where rp.room_id = r.id and rp.last_seen >= now() - interval '1 day'
      );

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

create index if not exists messages_room_team_id_idx on public.messages(room_id, team, id);

grant execute on function public.room_sync(uuid) to authenticated;
