-- Corrige "column reference room_id is ambiguous" en join_room: la columna de salida
-- room_id de returns table() chocaba con room_players.room_id.

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

  select rp.room_id into existing_room
  from public.room_players rp
  where rp.room_id = target_id and rp.user_id = uid
  limit 1;

  if existing_room is not null then
    update public.room_players rp
      set display_name = clean_name
      where rp.room_id = target_id and rp.user_id = uid;
    return query select target_id;
    return;
  end if;

  perform 1 from public.room_players rp
    where rp.room_id = target_id and rp.slot = p_slot
    for update;

  if exists (select 1 from public.room_players rp where rp.room_id = target_id and rp.slot = p_slot) then
    raise exception 'Ese puesto ya está ocupado.';
  end if;

  insert into public.room_players(room_id, user_id, team, slot, display_name)
  values (target_id, uid, p_team, p_slot, clean_name);

  return query select target_id;
end;
$$;
