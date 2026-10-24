-- Personaje del equipo: el héroe que el equipo rival tiene que adivinar.
--
-- * Lo elige cualquiera de los dos jugadores del equipo al entrar; gana el primero que lo confirma y ya
--   no se puede cambiar. Se guarda en team_boards, así que solo lo leen su equipo y su vista OBS.
-- * room_sync lo devuelve para que el compañero y la vista OBS lo reciban aunque se pierda el broadcast.

alter table public.team_boards
  add column if not exists character text;

create or replace function public.choose_team_character(
  p_room_id uuid,
  p_team smallint,
  p_character text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  chosen text;
begin
  if auth.uid() is null or public.member_team(p_room_id) is distinct from p_team then
    raise exception 'No tienes permiso para elegir el personaje de este equipo.';
  end if;

  if not exists (
    select 1 from public.rooms r where r.id = p_room_id and r.characters ? p_character
  ) then
    raise exception 'Ese héroe no está en esta sala.';
  end if;

  update public.team_boards
    set character = p_character, updated_at = now()
    where room_id = p_room_id and team = p_team and character is null;

  -- Si el compañero ya lo había elegido se devuelve el suyo.
  select tb.character into chosen
  from public.team_boards tb
  where tb.room_id = p_room_id and tb.team = p_team;

  return chosen;
end;
$$;

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
    -- Personaje del propio equipo; el del rival nunca se envía.
    'character', (
      select tb.character
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

grant execute on function public.choose_team_character(uuid, smallint, text) to authenticated;
