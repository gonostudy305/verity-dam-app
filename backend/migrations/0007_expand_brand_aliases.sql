-- Add explicit WooCommerce brand values without rewriting existing metadata.
insert into public.verity_taxonomy_options (facet, value, label, sort_order)
select 'brand', 'Acme', 'Acme', 35
where not exists (
  select 1 from public.verity_taxonomy_options
  where lower(facet) = 'brand' and lower(value) = 'acme'
);
