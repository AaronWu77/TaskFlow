# Repository Guidelines

## Project Structure & Module Organization

TaskFlow combines a React + Vite frontend, Express + Prisma backend, and Capacitor iOS shell.

- `src/` contains the frontend. Main app logic is in `src/app/App.tsx`; auth UI is in `src/app/AuthPage.tsx`; API/storage helpers live in `src/app/api.ts` and `src/app/storage.ts`.
- `src/app/components/ui/` contains shadcn/Radix UI wrappers; reuse these before adding primitives.
- `src/i18n/locales/` stores `en.json` and `zh.json`; update both for user-facing text.
- `src/styles/` contains global CSS, Tailwind entries, and design tokens in `theme.css`.
- `backend/src/` contains the API, routes, services, and Prisma schema/migrations.
- `scripts/` contains Node test scripts. `public/` stores static web assets; `ios/` stores the Capacitor iOS project.

## Build, Test, and Development Commands

- `pnpm install` installs root frontend dependencies.
- `pnpm run dev` starts Vite at `http://localhost:5173`.
- `pnpm run build` builds the frontend into `dist/`.
- `npm test` runs Node tests from `scripts/*.test.mjs`.
- `npm run check` builds frontend, builds backend, then runs tests.
- `cd backend && npm run dev` starts the backend via `tsx watch`.
- `cd backend && npm run build` builds the backend TypeScript.
- `cd backend && npm run db:generate` regenerates Prisma client after schema changes.
- `npm run cap:sync` rebuilds and syncs the Capacitor iOS project.

## Coding Style & Naming Conventions

Use TypeScript/TSX and ES modules. Follow two-space indentation and functional React components. Use PascalCase for components, camelCase for functions/variables, and descriptive route/service filenames such as `tasks.ts`. Prefer semantic Tailwind tokens from `src/styles/theme.css` (`bg-card`, `text-primary`, `border-border`) over hardcoded colors. Use `cn()` from `src/app/components/ui/utils.ts` for conditional classes.

## Testing Guidelines

Tests use Node's built-in test runner. Place regression tests in `scripts/` with the `*.test.mjs` suffix. For backend changes, run `cd backend && npm run build`; for cross-cutting changes, run `npm run check`. Add focused tests for sync logic, ordering, recurrence, and auth-sensitive behavior.

## Commit & Pull Request Guidelines

Recent commits use short release-oriented messages, often version-prefixed, for example `3.1.6 同步bug修复` or `4.0.0 预发布版本`. Keep commits focused and describe the user-visible change. Pull requests should include a summary, test results (`npm run check` when applicable), linked issues, screenshots for UI changes, and notes for migrations, environment variables, or iOS sync steps.

## Security & Configuration Tips

Do not commit secrets. Use `.env`, `.env.local`, and `backend/.env` for local configuration. Set `VITE_API_URL` before production builds, and keep JWT, database, and cookie settings aligned with `docker-compose.yml` and `nginx.conf`.
