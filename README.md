# TaskFlow

> A personal task management app centered on flow, not calendars — always showing you the *one* thing to focus on next.

TaskFlow replaces the anxiety of a never-ending list with a card-stack interface. Swipe through tasks one at a time, track your daily streak, and optionally browse a calendar view to see what's scheduled. All data is stored locally in the browser — no account required.

## Features

- **Flow view** — one task card at a time with Complete, Snooze, and Skip actions
- **Calendar view** — monthly grid with per-day task lists and inline task detail modal
- **Drag-to-reorder** — bottom sheet with grip handles to reprioritize your queue
- **Progress tracking** — per-task progress slider (0–100 %) with a live wave fill animation
- **Daily streak** — consecutive completion days tracked in `localStorage`
- **Repeat task** — re-queue a completed task with one tap from the calendar
- **Dark mode** — full light/dark theme via CSS custom properties

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) (recommended) or npm

### Installation

```bash
pnpm install
```

### Development

```bash
pnpm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Production build

```bash
pnpm run build
```

> [!NOTE]
> The project uses a `pnpm-workspace.yaml` workspace config. Both `pnpm` and `npm` work, but `pnpm` is preferred.

## Tech Stack

| Layer | Library |
|---|---|
| Framework | React 18 + Vite 6 |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Animations | `motion/react` (spring physics) |
| UI primitives | shadcn/ui — Radix UI wrappers in `src/app/components/ui/` |
| Dialogs | `@radix-ui/react-dialog` (used directly for task modals) |
| Icons | `lucide-react` |
| Persistence | `localStorage` (no backend) |

## Project Structure

```
src/
├── app/
│   ├── App.tsx                  # Entire application — all types, state, and components
│   └── components/
│       ├── ui/                  # shadcn/ui component library (do not modify)
│       └── figma/
│           └── ImageWithFallback.tsx
├── styles/
│   ├── theme.css                # CSS custom properties (design tokens, light + dark)
│   └── index.css
└── main.tsx
```

> [!IMPORTANT]
> All application logic lives in a single file: `src/app/App.tsx`. There is no routing — this is a single-page app.

## Data Model

```ts
interface Task {
  id: string;
  title: string;
  priority: 'P1' | 'P2' | 'P3';   // High / Medium / Low
  estimateMinutes: number;
  status: 'todo' | 'doing' | 'done' | 'snoozed' | 'skipped';
  tag?: string;                    // One of: Work, Personal, Study, Planning, Health, Other
  progress: number;                // 0–100
  dueDate?: string | null;         // 'YYYY-MM-DD'
}
```

Data is persisted under three `localStorage` keys:

| Key | Contents |
|---|---|
| `taskflow_tasks` | Task array |
| `taskflow_streak` | `{ count, lastDate }` |
| `taskflow_completed_today` | `{ date, count }` |

## Design System

All color and spacing tokens are CSS custom properties defined in `src/styles/theme.css` and mapped into Tailwind via `@theme inline`. Use semantic Tailwind classes (`bg-card`, `text-primary`, `border-border`) — never hardcode hex values.

Dark mode is activated via the `.dark` class on a parent element.

Use `cn()` from `src/app/components/ui/utils.ts` for conditional class merging (`clsx` + `tailwind-merge`).

## Acknowledgements

UI design and asset generation by [Figma Make](https://www.figma.com/design/qG1eukwOvwztxOcpCx1h5j/).  
Third-party attributions are listed in [ATTRIBUTIONS.md](./ATTRIBUTIONS.md).
