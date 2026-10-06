-- Unirse por equipo con puesto automático, consultar puestos libres y liberar el puesto al salir.

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

  select rp.team, rp.slot into current_team, current_slot
  from public.room_players rp
  where rp.room_id = target_id and rp.user_id = uid;

  if current_team = p_team then
    update public.room_players rp
      set display_name = clean_name
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
      set team = p_team, slot = free_slot, display_name = clean_name, joined_at = now()
      where rp.room_id = target_id and rp.user_id = uid;
  else
    insert into public.room_players(room_id, user_id, team, slot, display_name)
    values (target_id, uid, p_team, free_slot, clean_name);
  end if;

  return query select target_id, free_slot;
end;
$$;

create or replace function public.leave_room(p_room_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.room_players
  where room_id = p_room_id and user_id = auth.uid();
$$;

grant execute on function public.room_availability(text) to authenticated;
grant execute on function public.join_team(text, text, smallint) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;
