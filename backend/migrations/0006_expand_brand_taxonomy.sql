-- Expand the shared brand vocabulary used by Vision and reviewer filters.
-- Existing media values are not rewritten; admins can still add more brands.

insert into public.verity_taxonomy_options (facet, value, label, sort_order)
select candidate.facet, candidate.value, candidate.label, candidate.sort_order
from (values
  ('brand', 'Imex', 'Imex', 40),
  ('brand', 'Levoit', 'Levoit', 50),
  ('brand', 'Drift', 'Drift', 60),
  ('brand', 'Ecolo', 'Ecolo', 70),
  ('brand', 'Rover', 'Rover', 80),
  ('brand', 'Tabo', 'Tabo', 90),
  ('brand', 'TP-Link', 'TP-Link', 100),
  ('brand', 'EDEN', 'EDEN', 110),
  ('brand', 'Orbit', 'Orbit', 120),
  ('brand', 'Philips', 'Philips', 130),
  ('brand', 'Lyra', 'Lyra', 140),
  ('brand', 'Lockin', 'Lockin', 150),
  ('brand', 'SwitchBot', 'SwitchBot', 160),
  ('brand', 'Tera', 'Tera', 170),
  ('brand', 'UGREEN', 'UGREEN', 180),
  ('brand', 'Anker', 'Anker', 190),
  ('brand', 'Nova', 'Nova', 200),
  ('brand', 'Samsung', 'Samsung', 210),
  ('brand', 'LG', 'LG', 220),
  ('brand', 'Dyson', 'Dyson', 230),
  ('brand', 'VerityDAM Platform', 'VerityDAM Platform', 240),
  ('brand', 'Dreamhome', 'Dreamhome', 250),
  ('brand', 'Kesulo', 'Kesulo', 260)
) as candidate(facet, value, label, sort_order)
where not exists (
  select 1 from public.verity_taxonomy_options existing
  where lower(existing.facet) = lower(candidate.facet)
    and lower(existing.value) = lower(candidate.value)
);
