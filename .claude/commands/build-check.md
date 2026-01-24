# Build Check

Build all packages and report any TypeScript compilation errors.

## Steps

1. Run the full turborepo build:
   ```bash
   npm run build
   ```

2. If there are errors, list them clearly with file paths and line numbers.

3. Fix any type errors found, then re-run the build to confirm resolution.

## Notes
- Build order is: shared → db → api, worker, frontend (managed by Turborepo)
- The `db` package uses ESM (`"type": "module"`)
- Other packages use CommonJS (`"type": "commonjs"` or no type field)
- If a shared/db type changes, downstream packages may break — fix upstream first
