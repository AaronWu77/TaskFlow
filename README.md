# TaskFlow

> A personal task management app centered on flow, not calendars — always showing you the *one* thing to focus on next.

TaskFlow replaces the anxiety of a never-ending list with a card-stack interface. Swipe through tasks one at a time, track your daily streak, and optionally browse a calendar view to see what's scheduled. Sign in once and your tasks sync to a self-hosted backend across all your devices.

## Features

- **Flow view** — one task card at a time with Complete, Snooze, and Skip actions
- **Calendar view** — monthly grid with per-day task lists and inline task detail modal
- **Drag-to-reorder** — bottom sheet with grip handles to reprioritize your queue
- **Smart insertion** — new tasks are automatically placed at the right position by deadline then priority
- **Daily streak** — consecutive completion days tracked and synced
- **Repeat task** — re-queue a completed task with one tap from the calendar
- **Auth** — email + password registration/login; JWT access token + httpOnly refresh cookie
- **Self-hosted backend** — Docker Compose stack (Node.js API + PostgreSQL + Nginx)

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) (recommended) or npm

### Frontend — development

```bash
pnpm install
pnpm run dev          # http://localhost:5173
```

### Backend — local development

```bash
cd backend
cp .env.example .env  # fill in secrets
npm install
npm run db:generate   # generate Prisma client
# start a local PostgreSQL instance first, then:
npm run dev           # http://localhost:3000
```

### Production — Docker Compose

```bash
cp .env.example .env  # fill in POSTGRES_PASSWORD, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
docker compose up -d
```

The API will be available at `http://your-server/api/`.

> [!NOTE]
> Set `VITE_API_URL=https://your-server/api` before running `pnpm run build` so the frontend points to your backend.

### Production build (frontend)

```bash
VITE_API_URL=https://your-server/api pnpm run build
```

## Tech Stack

### Frontend
| Layer | Library |
|---|---|
| Framework | React 18 + Vite 6 |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Animations | `motion/react` (spring physics) |
| UI primitives | shadcn/ui — Radix UI wrappers in `src/app/components/ui/` |
| Dialogs | `@radix-ui/react-dialog` (used directly for task modals) |
| Icons | `lucide-react` |
| Mobile | Capacitor (iOS) |

### Backend
| Layer | Library |
|---|---|
| Runtime | Node.js 22 |
| Framework | Express 4 + TypeScript |
| ORM | Prisma 5 + PostgreSQL 16 |
| Auth | bcryptjs + jsonwebtoken |
| Deployment | Docker Compose + Nginx |

## Project Structure

```
├── src/                       # Frontend (React + Vite)
│   └── app/
│       ├── App.tsx            # All UI components, state, and routing logic
│       ├── AuthPage.tsx       # Login / Register screen
│       ├── api.ts             # API client (auto token refresh)
│       └── components/ui/    # shadcn/ui component library
├── backend/                   # Backend API
│   └── src/
│       ├── index.ts           # Express entry point
│       ├── middleware/auth.ts # JWT middleware
│       ├── routes/auth.ts     # Register / Login / Refresh / Logout
│       ├── routes/tasks.ts    # Task CRUD + reorder
│       └── prisma/schema.prisma
├── docker-compose.yml         # Production stack
├── nginx.conf                 # Reverse proxy config
└── .env.example               # Environment variable template
```

## Data Model

```ts
interface Task {
  id: string;
  title: string;
  priority: 'P1' | 'P2' | 'P3';   // High / Medium / Low
  estimateMinutes: number;
  status: 'todo' | 'doing' | 'done' | 'snoozed' | 'skipped';
  tag?: string;                    // Work | Personal | Study | Planning | Health | Other
  dueDate?: string | null;         // 'YYYY-MM-DD'
  sortOrder: number;               // user-defined position in flow
}
```

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create account |
| POST | `/auth/login` | — | Sign in, get tokens |
| POST | `/auth/refresh` | cookie | Refresh access token |
| POST | `/auth/logout` | — | Clear refresh cookie |
| GET | `/tasks` | Bearer | List all tasks |
| POST | `/tasks` | Bearer | Create task |
| PATCH | `/tasks/:id` | Bearer | Update task |
| DELETE | `/tasks/:id` | Bearer | Delete task |
| PUT | `/tasks/reorder` | Bearer | Bulk update sortOrder |

## Design System

All color and spacing tokens are CSS custom properties defined in `src/styles/theme.css` and mapped into Tailwind via `@theme inline`. Use semantic Tailwind classes (`bg-card`, `text-primary`, `border-border`) — never hardcode hex values.

Use `cn()` from `src/app/components/ui/utils.ts` for conditional class merging (`clsx` + `tailwind-merge`).

## Full Repository Structure

```
TaskFlow/
├── src/                          # ──  FRONTEND (React 18 + Vite 6) ──
│   ├── app/
│   │   ├── App.tsx               # Main app — all UI components, state, view logic
│   │   ├── AuthPage.tsx          # Login / Register screen
│   │   ├── api.ts                # API client — auth, auto-refresh, task CRUD
│   │   ├── storage.ts            # Storage layer — localStorage + Capacitor Preferences
│   │   └── components/
│   │       ├── ui/               # shadcn/ui library (Radix UI wrappers, do not modify)
│   │       └── figma/
│   │           └── ImageWithFallback.tsx
│   ├── i18n/
│   │   ├── index.ts              # i18next init (react-i18next)
│   │   └── locales/
│   │       ├── en.json           # English translations
│   │       └── zh.json           # Chinese translations
│   ├── main.tsx                  # React entry — renders <App />
│   └── styles/
│       ├── theme.css             # Design tokens (CSS variables, light theme)
│       ├── index.css             # Global styles entry
│       ├── globals.css
│       ├── tailwind.css
│       └── fonts.css
├── backend/                      # ──  BACKEND (Express + Prisma + PostgreSQL) ──
│   ├── src/
│   │   ├── index.ts              # Express server entry
│   │   ├── middleware/
│   │   │   └── auth.ts           # JWT Bearer auth middleware
│   │   ├── routes/
│   │   │   ├── auth.ts           # Register / Login / Refresh / Logout
│   │   │   ├── tasks.ts          # Task CRUD + reorder
│   │   │   └── user.ts           # User stats (streak)
│   │   └── prisma/
│   │       └── schema.prisma     # DB schema (User, Task, UserStats)
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── doc/                          # Documentation
│   ├── DEVELOPER.md
│   ├── plan.md
│   └── VERSIONING.md
├── public/                       # Static assets (PWA icons, manifest)
├── docker-compose.yml            # Production: API + PostgreSQL + Nginx
├── nginx.conf                    # Reverse proxy config
├── capacitor.config.ts           # Capacitor iOS config
├── vite.config.ts                # Vite + Tailwind + Figma asset plugin
├── index.html                    # HTML entry
├── package.json                  # Frontend dependencies
├── pnpm-workspace.yaml
├── .env.example
├── README.md                     # English docs (this file)
└── README.zh.md                  # Chinese docs
```

**Frontend/Backend boundary**: `src/` is the standalone React SPA. `backend/` is the standalone Express API. They communicate via REST (`src/app/api.ts` → `backend/src/routes/*`). Each can be developed, built, and deployed independently.

## Acknowledgements

UI design and asset generation by [Figma Make](https://www.figma.com/design/qG1eukwOvwztxOcpCx1h5j/).  
Third-party attributions are listed in [ATTRIBUTIONS.md](./ATTRIBUTIONS.md).
