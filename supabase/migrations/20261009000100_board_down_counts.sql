-- Número de fichas bajadas de cada equipo, sin revelar cuáles. Lo usa el mini-tablero del rival;
-- el tablero completo sigue siendo legible solo por su propio equipo.
create or replace function public.board_down_counts(p_room_id uuid)
returns table(team smallint, down integer)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not (public.is_room_member(p_room_id) or public.spectator_team(p_room_id) is not null) then
    raise exception 'No perteneces a esta sala.';
  end if;

  return query
  select tb.team, coalesce(cardinality(tb.flipped), 0)
  from public.team_boards tb
  where tb.room_id = p_room_id;
end;
$$;

grant execute on function public.board_down_counts(uuid) to authenticated;
