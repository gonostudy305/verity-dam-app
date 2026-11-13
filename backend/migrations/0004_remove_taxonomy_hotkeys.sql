-- Reviewer hotkeys are no longer part of the taxonomy contract.
drop index if exists public.verity_taxonomy_options_hotkey_active_idx;
alter table if exists public.verity_taxonomy_options drop column if exists hotkey;
