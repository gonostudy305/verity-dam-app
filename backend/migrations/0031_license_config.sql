-- 0031_license_config.sql
-- Add license and licensor configuration to verity_metadata_defaults_config

alter table public.verity_metadata_defaults_config
  add column if not exists license_url          text default 'https://veritydam.example/chinh-sach-ban-quyen',
  add column if not exists licensor_name        text default 'VerityDAM Platform',
  add column if not exists licensor_url         text default 'https://veritydam.example',
  add column if not exists acquire_license_page text default 'https://veritydam.example/lien-he',
  add column if not exists web_statement_url    text default 'https://veritydam.example/chinh-sach-ban-quyen';

-- Seed default values for existing rows
update public.verity_metadata_defaults_config
  set license_url          = coalesce(license_url, 'https://veritydam.example/chinh-sach-ban-quyen'),
      licensor_name        = coalesce(licensor_name, 'VerityDAM Platform'),
      licensor_url         = coalesce(licensor_url, 'https://veritydam.example'),
      acquire_license_page = coalesce(acquire_license_page, 'https://veritydam.example/lien-he'),
      web_statement_url    = coalesce(web_statement_url, 'https://veritydam.example/chinh-sach-ban-quyen')
  where config_key = 'default';
