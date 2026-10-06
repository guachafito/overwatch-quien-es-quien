# Supabase

- `migrations/20261006000100_initial.sql` is the migration used by the Supabase GitHub integration.
- `schema.sql` is kept as a human-readable copy for reference/manual setup.
- In Supabase, enable **Authentication > Providers > Anonymous Sign-Ins**.
- Then connect the GitHub repository from **Project Settings > Integrations > GitHub Integration** and enable production deployment from `main`.
