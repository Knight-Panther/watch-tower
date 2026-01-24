# Start Development Environment

Start infrastructure and all development services for the watch-tower project.

## Steps

1. Start Docker containers (PostgreSQL + Redis):
   ```bash
   docker compose up -d
   ```

2. Wait for PostgreSQL to be healthy:
   ```bash
   docker compose exec postgres pg_isready -U watchtower
   ```

3. Push the database schema (if not already applied):
   ```bash
   npm run db:push
   ```

4. Install dependencies if node_modules is missing:
   ```bash
   npm install
   ```

5. Build all packages:
   ```bash
   npm run build
   ```

6. Start all services in dev mode:
   ```bash
   npm run dev
   ```

## Notes
- PostgreSQL runs on port 5432, Redis on port 6379
- API runs on port 3001, Frontend on port 5173
- Check `.env` for connection strings if services fail to connect
