import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence, Reorder, useDragControls } from 'motion/react';
import {
  Check, X, Clock, Plus, Flame, CheckCircle2,
  Calendar, Tag, XCircle, ChevronLeft, ChevronRight,
  ListTodo, SkipForward, AlarmClock, RotateCcw,
  GripVertical, ArrowUpDown, Globe,
  Search, Bell, RotateCw
} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { storageGet, storageSet, storageRemove, restoreFromNativeStorage } from './storage';
import { AuthPage } from './AuthPage';
import { apiLogout, clearLocalAuthTokens, setAuthFailureHandler, apiGetTasks, apiCreateTask, apiUpdateTask, apiReorderTasks, apiGetUserStats, apiUpdateUserStats, apiRefreshDetailed } from './api';
import { toast, Toaster } from 'sonner';
import { cn } from './components/ui/utils';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

// --- Types ---
type Priority = 'P1' | 'P2' | 'P3';
type TaskStatus = 'todo' | 'doing' | 'done' | 'snoozed' | 'skipped';
type ViewMode = 'flow' | 'calendar';
type ExitAction = 'complete' | 'skip' | 'snooze';

interface Task {
  id: string;
  title: string;
  priority: Priority;
  estimateMinutes: number;
  status: TaskStatus;
  tag?: string;
  progress: number;
  dueDate?: string | null;
  reminderAt?: string | null;
  repeatRule?: 'none' | 'daily' | 'weekly' | 'monthly' | null;
  deletedAt?: string | null;
  sortOrder: number;
  _dirty?: boolean; // local-only: true if pending sync to server
}

// Sync metadata
type SyncMeta = { lastSync: string };
const SYNC_META_KEY = 'taskflow_sync_meta';
const SESSION_KEY = 'taskflow_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SessionMeta = {
  email: string;
  signedOut: boolean;
  lastAuthenticatedAt: string;
};

function loadSession(): SessionMeta | null {
  try {
    const raw = storageGet(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SessionMeta>;
      // Accept session even with empty email if signedOut flag is present
      if (parsed.signedOut === true) {
        return {
          email: parsed.email || '',
          signedOut: true,
          lastAuthenticatedAt: parsed.lastAuthenticatedAt || new Date().toISOString(),
        };
      }
      if (parsed.email && parsed.lastAuthenticatedAt) {
        return {
          email: parsed.email,
          signedOut: parsed.signedOut === true,
          lastAuthenticatedAt: parsed.lastAuthenticatedAt,
        };
      }
    }

    const legacyLoggedIn = storageGet('taskflow_logged_in');
    const legacyEmail = storageGet('taskflow_user_email');
    if (legacyLoggedIn && legacyEmail) {
      return {
        email: legacyEmail,
        signedOut: false,
        lastAuthenticatedAt: new Date().toISOString(),
      };
    }
  } catch { /**/ }
  return null;
}

function saveSession(email: string): void {
  storageSet(SESSION_KEY, JSON.stringify({
    email,
    signedOut: false,
    lastAuthenticatedAt: new Date().toISOString(),
  } satisfies SessionMeta));
  storageSet('taskflow_logged_in', '1');
  storageSet('taskflow_user_email', email);
}

function clearSession(): void {
  storageSet(SESSION_KEY, JSON.stringify({
    email: '',
    signedOut: true,
    lastAuthenticatedAt: new Date().toISOString(),
  } satisfies SessionMeta));
  storageRemove('taskflow_logged_in');
  storageRemove('taskflow_user_email');
}

function isSessionExpired(session: SessionMeta): boolean {
  const last = new Date(session.lastAuthenticatedAt).getTime();
  return Number.isNaN(last) || Date.now() - last > SESSION_TTL_MS;
}

function loadSyncMeta(): SyncMeta {
  try {
    const raw = storageGet(SYNC_META_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /**/ }
  return { lastSync: '' };
}

function saveSyncMeta(meta: SyncMeta) {
  storageSet(SYNC_META_KEY, JSON.stringify(meta));
}

/** Mark a task as dirty (in-memory only — cache save via useEffect) */
function markDirty(tasks: Task[], id: string): Task[] {
  return tasks.map(t => t.id === id ? { ...t, _dirty: true } : t);
}

/** Mark a task as clean (in-memory only — cache save via useEffect) */
function markClean(tasks: Task[], id: string): Task[] {
  return tasks.map(t => t.id === id ? { ...t, _dirty: false } : t);
}

/** Push all dirty tasks to server, returning tasks with clean flags */
async function flushDirtyTasks(tasks: Task[]): Promise<Task[]> {
  const dirty = tasks.filter(t => t._dirty);
  if (dirty.length === 0) return tasks;

  let updated = [...tasks];
  for (const t of dirty) {
    try {
      const remote = await apiGetTasks().catch(() => [] as { id: string }[]);
      const exists = remote.some((r: { id: string }) => r.id === t.id);
      if (exists) {
        await apiUpdateTask(t.id, {
          title: t.title, priority: t.priority,
          estimateMinutes: t.estimateMinutes, status: t.status,
          tag: t.tag, progress: t.progress, dueDate: t.dueDate,
          reminderAt: t.reminderAt, repeatRule: t.repeatRule, deletedAt: t.deletedAt,
          sortOrder: t.sortOrder,
        });
      } else {
        const created = await apiCreateTask({
          title: t.title, priority: t.priority,
          estimateMinutes: t.estimateMinutes, status: t.status,
          tag: t.tag, progress: t.progress, dueDate: t.dueDate,
          reminderAt: t.reminderAt, repeatRule: t.repeatRule, deletedAt: t.deletedAt,
          sortOrder: t.sortOrder,
        });
        updated = updated.map(x => x.id === t.id ? { ...x, id: created.id, _dirty: false } : x);
        continue;
      }
      updated = markClean(updated, t.id);
    } catch {
      // Keep dirty, will retry later
    }
  }
  return updated;
}

// --- Constants ---
const PRESET_TAGS = ['Work', 'Personal', 'Study', 'Planning', 'Health', 'Other'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const PRIORITY_BADGE = {
  P1: 'text-rose-600 bg-rose-100',
  P2: 'text-amber-600 bg-amber-100',
  P3: 'text-emerald-600 bg-emerald-100',
};
const PRIORITY_LABEL = { P1: 'High Priority', P2: 'Medium Priority', P3: 'Low Priority' };
const PRIORITY_LABEL_KEY: Record<Priority, string> = { P1: 'priority.P1', P2: 'priority.P2', P3: 'priority.P3' };
const DOT_COLOR = { P1: 'bg-rose-500', P2: 'bg-amber-400', P3: 'bg-emerald-500' };
const ACCENT_THEME_KEY = 'taskflow_accent_theme';

type AccentTheme = 'lavender' | 'ocean' | 'forest' | 'sunset' | 'rose';

const ACCENT_THEME_PRESETS: Record<AccentTheme, {
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  ring: string;
}> = {
  lavender: {
    primary: '#a78bfa',
    primaryForeground: '#ffffff',
    secondary: '#f1eaff',
    secondaryForeground: '#6d4cc2',
    ring: '#a78bfa',
  },
  ocean: {
    primary: '#3b82f6',
    primaryForeground: '#ffffff',
    secondary: '#eaf3ff',
    secondaryForeground: '#1d4ed8',
    ring: '#3b82f6',
  },
  forest: {
    primary: '#16a34a',
    primaryForeground: '#ffffff',
    secondary: '#e9f9ef',
    secondaryForeground: '#166534',
    ring: '#16a34a',
  },
  sunset: {
    primary: '#f97316',
    primaryForeground: '#ffffff',
    secondary: '#fff1e7',
    secondaryForeground: '#c2410c',
    ring: '#f97316',
  },
  rose: {
    primary: '#e11d48',
    primaryForeground: '#ffffff',
    secondary: '#ffe9f0',
    secondaryForeground: '#be123c',
    ring: '#e11d48',
  },
};

function loadAccentTheme(): AccentTheme {
  const raw = storageGet(ACCENT_THEME_KEY);
  if (!raw) return 'lavender';
  if (raw in ACCENT_THEME_PRESETS) return raw as AccentTheme;
  return 'lavender';
}

function applyAccentTheme(theme: AccentTheme): void {
  const preset = ACCENT_THEME_PRESETS[theme] ?? ACCENT_THEME_PRESETS.lavender;
  const root = document.documentElement;
  root.style.setProperty('--primary', preset.primary);
  root.style.setProperty('--primary-foreground', preset.primaryForeground);
  root.style.setProperty('--secondary', preset.secondary);
  root.style.setProperty('--secondary-foreground', preset.secondaryForeground);
  root.style.setProperty('--ring', preset.ring);
}

// --- Translation-aware helpers ---
const PRIORITY_TAGS = ['P1', 'P2', 'P3'] as const;

function getGreeting(t: (key: string) => string): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return t('greeting.morning');
  if (h >= 12 && h < 17) return t('greeting.afternoon');
  if (h >= 17 && h < 21) return t('greeting.evening');
  return t('greeting.night');
}

function syncAppViewportHeight(forceInnerHeight = false) {
  const viewport = window.visualViewport;
  const viewportHeight = forceInnerHeight
    ? window.innerHeight
    : (viewport?.height ?? window.innerHeight);
  const nextHeight = Math.max(320, Math.round(viewportHeight));
  document.documentElement.style.setProperty('--app-vh', `${nextHeight}px`);
}

function loadTasks(): Task[] {
  try {
    const raw = storageGet('taskflow_tasks');
    if (raw) return JSON.parse(raw) as Task[];
  } catch { /**/ }
  return [];
}

function saveTasksToCache(tasks: Task[]) {
  try {
    storageSet('taskflow_tasks', JSON.stringify(tasks));
  } catch { /**/ }
}

// --- Persistence helpers ---
const todayStr = () => new Date().toISOString().split('T')[0];

function loadStatsFromCache(): { streak: number; completedToday: number } {
  let streak = 0, completedToday = 0;
  try {
    const rawS = storageGet('taskflow_streak');
    if (rawS) {
      const { count, lastDate } = JSON.parse(rawS) as { count: number; lastDate: string };
      const today = todayStr();
      if (lastDate === today) streak = count;
      else {
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
        if (lastDate === yesterday.toISOString().split('T')[0]) streak = count;
      }
    }
    const rawC = storageGet('taskflow_completed_today');
    if (rawC) {
      const { date, count } = JSON.parse(rawC) as { date: string; count: number };
      completedToday = date === todayStr() ? count : 0;
    }
  } catch { /**/ }
  return { streak, completedToday };
}

function saveStatsToCache(streak: number, completedToday: number, lastDate?: string | null) {
  const today = todayStr();
  storageSet('taskflow_streak', JSON.stringify({ count: streak, lastDate: lastDate || today }));
  storageSet('taskflow_completed_today', JSON.stringify({ date: today, count: completedToday }));
}

function fmtDate(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function nextRepeatDate(dueDate: string | null | undefined, rule: Task['repeatRule']): string | null {
  if (!dueDate || !rule || rule === 'none') return null;
  const next = new Date(`${dueDate}T12:00:00`);
  if (Number.isNaN(next.getTime())) return null;
  if (rule === 'daily') next.setDate(next.getDate() + 1);
  if (rule === 'weekly') next.setDate(next.getDate() + 7);
  if (rule === 'monthly') next.setMonth(next.getMonth() + 1);
  return fmtDate(next.getFullYear(), next.getMonth(), next.getDate());
}

// --- Add Task Form state ---
interface AddTaskState {
  title: string;
  minutes: string;
  priority: Priority;
  dueDate: string;
  reminderAt: string;
  repeatRule: 'none' | 'daily' | 'weekly' | 'monthly';
  tag: string;
}
const DEFAULT_FORM: AddTaskState = { title: '', minutes: '25', priority: 'P2', dueDate: '', reminderAt: '', repeatRule: 'none', tag: PRESET_TAGS[0] };

// Returns index at which newTask should be inserted among existing tasks.
// Only compares against 'todo' tasks; preserves manual ordering otherwise.
const PRIORITY_RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3 };
function insertIndex(tasks: Task[], newTask: Task): number {
  const idx = tasks.findIndex(t => {
    if (t.status !== 'todo') return false;
    const nd = newTask.dueDate, ed = t.dueDate;
    if (nd && !ed) return true;
    if (!nd && ed) return false;
    if (nd && ed) {
      if (nd < ed) return true;
      if (nd > ed) return false;
    }
    return PRIORITY_RANK[newTask.priority] < PRIORITY_RANK[t.priority];
  });
  return idx === -1 ? tasks.length : idx;
}

// --- View Toggle ---
function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const { t } = useTranslation();
  return (
    <div className="relative flex items-center bg-muted rounded-full p-1">
      <button
        onClick={() => onChange('flow')}
        className={`relative flex items-center justify-center gap-2 w-32 py-2 text-sm font-semibold rounded-full transition-colors duration-200 ${view === 'flow' ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {view === 'flow' && (
          <motion.div
            layoutId="view-toggle"
            className="absolute inset-0 bg-card rounded-full shadow-sm border border-border"
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
          />
        )}
        <span className="relative z-10 flex items-center gap-2"><ListTodo className="w-3.5 h-3.5 flex-shrink-0" />{t('view.flow')}</span>
      </button>
      <button
        onClick={() => onChange('calendar')}
        className={`relative flex items-center justify-center gap-2 w-32 py-2 text-sm font-semibold rounded-full transition-colors duration-200 ${view === 'calendar' ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {view === 'calendar' && (
          <motion.div
            layoutId="view-toggle"
            className="absolute inset-0 bg-card rounded-full shadow-sm border border-border"
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
          />
        )}
        <span className="relative z-10 flex items-center gap-2"><Calendar className="w-3.5 h-3.5 flex-shrink-0" />{t('view.calendar')}</span>
      </button>
    </div>
  );
}

// --- Task Card ---
interface TaskCardProps {
  task: Task;
  onAction: (id: string, action: ExitAction) => void;
  onProgressChange: (id: string, progress: number) => void;
  exitAction: ExitAction | null;
}


function TaskCard({ task, onAction, onProgressChange }: TaskCardProps) {
  const { t } = useTranslation();
  const [localProgress, setLocalProgress] = React.useState(task.progress);
  const [isSlidingProgress, setIsSlidingProgress] = React.useState(false);
  const blockActionUntilRef = React.useRef(0);
  React.useEffect(() => { setLocalProgress(task.progress); }, [task.progress]);

  const commitProgress = (value: number) => {
    if (value !== task.progress) onProgressChange(task.id, value);
  };

  const releaseSlidingGuard = () => {
    setIsSlidingProgress(false);
    // Guard against ghost click after touch/pointer release on mobile.
    blockActionUntilRef.current = Date.now() + 220;
  };

  const canTriggerAction = () => !isSlidingProgress && Date.now() > blockActionUntilRef.current;

  const handleAction = (e: React.MouseEvent<HTMLButtonElement>, action: ExitAction) => {
    e.stopPropagation();
    if (!canTriggerAction()) return;
    onAction(task.id, action);
  };

  return (
    <div className="relative w-full h-full bg-card rounded-3xl border border-border flex flex-col overflow-hidden">
      <div
        className="pointer-events-none absolute bottom-0 left-0 w-full bg-primary/10 transition-all duration-500 ease-out z-0"
        style={{ height: `${localProgress}%` }}
      >
        {localProgress > 0 && localProgress < 100 && (
          <div className="absolute top-[-20px] left-0 w-[200%] h-[20px] overflow-hidden z-0">
            <svg viewBox="0 0 800 50" preserveAspectRatio="none" className="w-full h-full fill-primary/10 animate-wave">
              <path d="M 0 25 Q 100 50 200 25 T 400 25 Q 500 50 600 25 T 800 25 L 800 50 L 0 50 Z" />
            </svg>
          </div>
        )}
      </div>
      <div className="relative z-10 flex flex-col h-full p-6">
        <div className="flex items-center justify-between mb-6">
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${PRIORITY_BADGE[task.priority]}`}>{t(PRIORITY_LABEL_KEY[task.priority])}</span>
          {task.tag && (
            <span className="text-xs font-medium text-muted-foreground bg-muted/80 backdrop-blur-sm px-2.5 py-1 rounded-full flex items-center gap-1">
              <Tag className="w-3 h-3" />{task.tag}
            </span>
          )}
        </div>
        <h2 className="text-3xl font-bold leading-tight flex-1">{task.title}</h2>
        <div className="mt-auto flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center text-muted-foreground text-sm gap-1.5 bg-muted/50 backdrop-blur-sm px-3 py-1.5 rounded-lg">
                <Clock className="w-4 h-4" /><span>{task.estimateMinutes}m</span>
              </div>
              {task.dueDate && (
                <div className="flex items-center text-muted-foreground text-sm gap-1.5 bg-muted/50 backdrop-blur-sm px-3 py-1.5 rounded-lg">
                  <Calendar className="w-4 h-4" /><span>{task.dueDate}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 bg-muted/30 backdrop-blur-sm px-3 py-2 rounded-lg">
              <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">{t('task.progress')}</span>
              <div
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerMove={(e) => e.stopPropagation()}
                className="flex-1"
              >
                <input
                  type="range" min="0" max="100" step="5"
                  value={localProgress}
                  onInput={(e) => setLocalProgress(parseInt((e.target as HTMLInputElement).value))}
                  onChange={(e) => {
                    const next = parseInt((e.target as HTMLInputElement).value);
                    setLocalProgress(next);
                    if (!isSlidingProgress) commitProgress(next);
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setIsSlidingProgress(true);
                  }}
                  onPointerUp={(e) => {
                    e.stopPropagation();
                    releaseSlidingGuard();
                    commitProgress(parseInt((e.target as HTMLInputElement).value));
                  }}
                  onPointerCancel={() => releaseSlidingGuard()}
                  onBlur={(e) => {
                    if (!isSlidingProgress) return;
                    releaseSlidingGuard();
                    const next = parseInt((e.target as HTMLInputElement).value);
                    commitProgress(next);
                  }}
                  className="w-full h-6 bg-transparent appearance-none cursor-pointer outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
                  style={{ accentColor: 'var(--primary)', WebkitTapHighlightColor: 'transparent' }}
                />
              </div>
              <span className="text-sm font-medium text-muted-foreground w-9 text-right">{localProgress}%</span>
            </div>
          </div>
          <div className="relative z-20 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={(e) => handleAction(e, 'snooze')}
              className="flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold transition-transform active:scale-95 touch-manipulation select-none bg-secondary/80 backdrop-blur-sm text-secondary-foreground"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <AlarmClock className="w-5 h-5" />{t('task.snooze')}
            </button>
            <button
              type="button"
              onClick={(e) => handleAction(e, 'skip')}
              className="flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold transition-transform active:scale-95 touch-manipulation select-none bg-muted/80 backdrop-blur-sm text-muted-foreground"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <SkipForward className="w-5 h-5" />{t('task.skip')}
            </button>
          </div>
          <button
            type="button"
            onClick={(e) => handleAction(e, 'complete')}
            className="relative z-20 w-full flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-lg shadow-lg shadow-primary/25 transition-transform active:scale-95 touch-manipulation select-none bg-primary text-primary-foreground"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <Check className="w-6 h-6" />{t('task.complete')}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Task Detail Modal (Calendar) ---
function TaskDetailModal({ task, onClose, onAction, onProgressChange }: {
  task: Task | null; onClose: () => void;
  onAction: (id: string, action: ExitAction) => void;
  onProgressChange: (id: string, progress: number) => void;
}) {
  return (
    <Dialog.Root open={!!task} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 backdrop-blur-md z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-full max-w-[360px] h-[520px] translate-x-[-50%] translate-y-[-50%] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 rounded-3xl focus:outline-none shadow-2xl">
          <Dialog.Title className="sr-only">{task?.title}</Dialog.Title>
          <Dialog.Description className="sr-only">Task actions</Dialog.Description>
          {task && (
            <TaskCard
              task={task}
              onAction={(id, action) => { onAction(id, action); onClose(); }}
              onProgressChange={onProgressChange}
              exitAction={null}
            />
          )}
          <Dialog.Close asChild>
            <button className="absolute -top-1 -right-1 z-20 w-9 h-9 flex items-center justify-center rounded-full bg-card border border-border shadow-sm text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// --- Repeat Task Modal ---
function RepeatTaskModal({ task, onClose, onRepeat }: {
  task: Task | null; onClose: () => void; onRepeat: (task: Task) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={!!task} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/20 backdrop-blur-md z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-full max-w-sm translate-x-[-50%] translate-y-[-50%] border border-border bg-card rounded-2xl p-6 shadow-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 focus:outline-none">
          <Dialog.Title className="text-base font-bold mb-1">{t('task.completedTask')}</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground mb-4">{t('task.donePrompt')}</Dialog.Description>
          {task && (
            <>
              <div className="bg-muted/50 rounded-xl p-4 mb-5 space-y-2">
                <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />{task.title}
                </p>
                <div className="flex flex-wrap gap-2 ml-6">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${PRIORITY_BADGE[task.priority]}`}>{t(PRIORITY_LABEL_KEY[task.priority])}</span>
                  {task.tag && <span className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" />{task.tag}</span>}
                  <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{task.estimateMinutes}m</span>
                </div>
              </div>
              <div className="flex gap-3">
                <Dialog.Close asChild>
                  <button className="flex-1 py-2.5 bg-muted text-muted-foreground rounded-xl text-sm font-semibold hover:bg-muted/80 transition-colors">{t('task.cancel')}</button>
                </Dialog.Close>
                <button onClick={() => { onRepeat(task); onClose(); }} className="flex-1 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-primary/90 transition-colors active:scale-95">
                  <RotateCcw className="w-4 h-4" />{t('task.repeatTask')}
                </button>
              </div>
            </>
          )}
          <Dialog.Close asChild>
            <button className="absolute right-4 top-4 opacity-70 transition-opacity hover:opacity-100"><XCircle className="h-4 w-4" /></button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// --- Reorder Row Item (with dedicated drag handle) ---
function ReorderRow({ task }: { task: Task }) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={task}
      dragListener={false}
      dragControls={controls}
      className="list-none"
      whileDrag={{ scale: 1.02, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 50 }}
      transition={{ duration: 0.15 }}
    >
      <div className="bg-card border border-border rounded-xl flex items-center gap-3 px-3 py-3.5 select-none">
        {/* Drag handle */}
        <button
          onPointerDown={(e) => { e.preventDefault(); controls.start(e); }}
          className="touch-none cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 p-1 -m-1 rounded"
        >
          <GripVertical className="w-5 h-5" />
        </button>
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT_COLOR[task.priority]}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground leading-snug truncate">{task.title}</p>
          {task.tag && <p className="text-xs text-muted-foreground mt-0.5">{task.tag}</p>}
        </div>
        <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md flex-shrink-0">{task.estimateMinutes}m</span>
      </div>
    </Reorder.Item>
  );
}

// --- Reorder Bottom Sheet ---
function ReorderSheet({ isOpen, pendingTasks, onClose, onSave }: {
  isOpen: boolean; pendingTasks: Task[];
  onClose: () => void; onSave: (ordered: Task[]) => void;
}) {
  const { t } = useTranslation();
  const [order, setOrder] = useState<Task[]>(pendingTasks);

  // Sync when tasks change externally
  React.useEffect(() => { setOrder(pendingTasks); }, [pendingTasks]);

  const handleDone = () => { onSave(order); onClose(); };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
            onClick={handleDone}
          />
          {/* Sheet */}
          <motion.div
            key="sheet"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 38, mass: 0.9 }}
            className="fixed bottom-0 left-0 right-0 z-50 bg-card rounded-t-3xl border-t border-border flex flex-col"
            style={{ maxHeight: '82vh' }}
          >
            {/* Handle bar */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div>
                <h2 className="text-base font-bold">{t('task.reorderTasks')}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{t('task.reorderHint')}</p>
              </div>
              <button
                onClick={handleDone}
                className="flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-2 rounded-xl text-sm font-semibold active:scale-95 transition-transform"
              >
                <Check className="w-4 h-4" />{t('task.done')}
              </button>
            </div>

            {/* Draggable list */}
            <div className="overflow-y-auto flex-1 px-4 py-3">
              {order.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <CheckCircle2 className="w-10 h-10 text-emerald-500 mb-3" />
                  <p className="text-sm text-muted-foreground">{t('task.noPendingTasks')}</p>
                </div>
              ) : (
                <Reorder.Group axis="y" values={order} onReorder={setOrder} className="space-y-2">
                  {order.map(task => <ReorderRow key={task.id} task={task} />)}
                </Reorder.Group>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-border">
              <p className="text-xs text-center text-muted-foreground">
                {order.length} {t('task.tasksInFlow')}
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// --- Calendar View ---
function CalendarView({ tasks, onAction, onProgressChange, onAddTask, onRepeatTask }: {
  tasks: Task[];
  onAction: (id: string, action: ExitAction) => void;
  onProgressChange: (id: string, progress: number) => void;
  onAddTask: () => void;
  onRepeatTask: (task: Task) => void;
}) {
  const { t, i18n } = useTranslation();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(
    fmtDate(today.getFullYear(), today.getMonth(), today.getDate())
  );
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const detailTask = detailTaskId ? tasks.find(t => t.id === detailTaskId) ?? null : null;
  const [repeatTask, setRepeatTask] = useState<Task | null>(null);
  const [query, setQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<'all' | Priority>('all');
  const [statusFilter, setStatusFilter] = useState<'active' | 'done' | 'skipped' | 'all'>('active');

  const translatedWeekdays = t('calendar.weekdays', { returnObjects: true }) as unknown as string[];
  const translatedMonths = t('calendar.months', { returnObjects: true }) as unknown as string[];

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayFmt = fmtDate(today.getFullYear(), today.getMonth(), today.getDate());

  const visibleTasks = tasks.filter(task => {
    if (task.deletedAt) return false;
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery = !normalizedQuery
      || task.title.toLowerCase().includes(normalizedQuery)
      || (task.tag ?? '').toLowerCase().includes(normalizedQuery);
    const matchesPriority = priorityFilter === 'all' || task.priority === priorityFilter;
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'active' ? task.status === 'todo' : task.status === statusFilter);
    return matchesQuery && matchesPriority && matchesStatus;
  });

  const pendingByDate: Record<string, Task[]> = {};
  visibleTasks.forEach(t => { if (t.dueDate && t.status === 'todo') (pendingByDate[t.dueDate] ??= []).push(t); });

  const allByDate: Record<string, Task[]> = {};
  visibleTasks.forEach(t => { if (t.dueDate) (allByDate[t.dueDate] ??= []).push(t); });

  const prevMonth = () => { month === 0 ? (setYear(y => y - 1), setMonth(11)) : setMonth(m => m - 1); setSelectedDate(null); };
  const nextMonth = () => { month === 11 ? (setYear(y => y + 1), setMonth(0)) : setMonth(m => m + 1); setSelectedDate(null); };

  const dayTasks = selectedDate ? (allByDate[selectedDate] || []) : [];
  const pendingDayTasks = dayTasks.filter(t => t.status === 'todo');
  const doneDayTasks = dayTasks.filter(t => t.status === 'done' || t.status === 'skipped');

  const cells: Array<number | null> = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <>
      <TaskDetailModal task={detailTask} onClose={() => setDetailTaskId(null)} onAction={onAction} onProgressChange={onProgressChange} />
      <RepeatTaskModal task={repeatTask} onClose={() => setRepeatTask(null)} onRepeat={onRepeatTask} />

      <div className="w-full max-w-md space-y-3">
        <div className={cn('bg-card border border-border rounded-2xl shadow-sm overflow-hidden', isSearchOpen ? 'p-2 space-y-2' : 'p-1.5')}>
          {!isSearchOpen ? (
            <button
              type="button"
              onClick={() => setIsSearchOpen(true)}
              className="flex h-9 w-full items-center gap-2 rounded-xl px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Search className="w-4 h-4" />
              <span className="flex-1 text-left">{t('task.searchPlaceholder')}</span>
              {(query || priorityFilter !== 'all' || statusFilter !== 'active') && <span className="h-2 w-2 rounded-full bg-primary" />}
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('task.searchPlaceholder')}
                  className="h-9 w-full rounded-xl border border-input bg-input-background pl-9 pr-10 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setIsSearchOpen(false)}
                  className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Hide search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value as 'all' | Priority)}
                  className="h-8 rounded-lg border border-input bg-input-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="all">{t('task.allPriorities')}</option>
                  <option value="P1">{t('priority.P1')}</option>
                  <option value="P2">{t('priority.P2')}</option>
                  <option value="P3">{t('priority.P3')}</option>
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'active' | 'done' | 'skipped' | 'all')}
                  className="h-8 rounded-lg border border-input bg-input-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="active">{t('view.toDo')}</option>
                  <option value="done">{t('view.completed')}</option>
                  <option value="skipped">{t('task.skipped')}</option>
                  <option value="all">{t('task.allStatuses')}</option>
                </select>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center justify-between px-1">
          <button onClick={prevMonth} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"><ChevronLeft className="w-5 h-5" /></button>
          <h2 className="text-base font-bold tracking-tight">{translatedMonths[month]} {year}</h2>
          <button onClick={nextMonth} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"><ChevronRight className="w-5 h-5" /></button>
        </div>

        <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
          <div className="grid grid-cols-7 border-b border-border">
            {translatedWeekdays.map(d => <div key={d} className="py-2 text-center text-xs font-semibold text-muted-foreground tracking-wide">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((day, idx) => {
              if (day === null) return <div key={`e-${idx}`} className="h-14 border-b border-r border-border/40 last:border-r-0" />;
              const dateStr = fmtDate(year, month, day);
              const dots = [...new Set((pendingByDate[dateStr] || []).map(t => t.priority))].sort() as Priority[];
              const isToday = dateStr === todayFmt;
              const isSelected = dateStr === selectedDate;
              return (
                <button
                  key={dateStr}
                  onClick={() => setSelectedDate(isSelected ? null : dateStr)}
                  className={`relative h-14 flex flex-col items-center justify-start pt-1.5 border-b border-r border-border/40 transition-colors group ${idx % 7 === 6 ? 'border-r-0' : ''} ${isSelected ? 'bg-primary/[0.07]' : 'hover:bg-muted/60'}`}
                >
                  <span className={`w-7 h-7 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${isToday ? 'bg-primary text-primary-foreground' : isSelected ? 'text-primary font-bold' : 'text-foreground'}`}>{day}</span>
                  {dots.length > 0 && (
                    <div className="flex items-center gap-0.5 mt-0.5">
                      {dots.map(p => <span key={p} className={`w-1.5 h-1.5 rounded-full ${DOT_COLOR[p]}`} />)}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500" />{t('calendar.high')}</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400" />{t('calendar.medium')}</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />{t('calendar.low')}</span>
          <span className="flex items-center gap-1.5 opacity-50"><span className="w-2 h-2 rounded-full bg-muted-foreground" />{t('calendar.pendingOnly')}</span>
        </div>

        <AnimatePresence mode="wait">
          {selectedDate && (
            <motion.div
              key={selectedDate}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="space-y-4"
            >
              <div className="flex items-center justify-between px-1">
                <h3 className="text-sm font-bold text-foreground">
                  {new Date(selectedDate + 'T12:00:00').toLocaleDateString(i18n.language === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </h3>
                <span className="text-xs text-muted-foreground">{dayTasks.length} {dayTasks.length === 1 ? 'task' : 'tasks'}</span>
              </div>

              {dayTasks.length === 0 ? (
                <div className="bg-card border border-border rounded-2xl p-5 flex flex-col items-center gap-3 text-center">
                  <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center"><Calendar className="w-5 h-5 text-muted-foreground" /></div>
                  <p className="text-sm text-muted-foreground">{t('task.noTasksScheduled')}</p>
                  <button onClick={onAddTask} className="text-sm font-semibold text-primary flex items-center gap-1 hover:opacity-80 transition-opacity"><Plus className="w-4 h-4" />{t('task.addTaskPrompt')}</button>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingDayTasks.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">{t('view.toDo')} — {pendingDayTasks.length}</p>
                      {pendingDayTasks.map((task, i) => (
                        <motion.button key={task.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, duration: 0.2 }}
                          onClick={() => setDetailTaskId(task.id)}
                          className="w-full text-left bg-card border border-border rounded-xl px-3 py-3 flex items-start gap-3 hover:border-primary/40 transition-all active:scale-[0.99]">
                          <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${DOT_COLOR[task.priority]}`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-foreground leading-snug">{task.title}</p>
                            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${PRIORITY_BADGE[task.priority]}`}>{t(PRIORITY_LABEL_KEY[task.priority])}</span>
                              {task.tag && <span className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" />{task.tag}</span>}
                              <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{task.estimateMinutes}m</span>
                            </div>
                            {task.progress > 0 && (
                              <div className="mt-2 flex items-center gap-2">
                                <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden"><div className="h-full bg-primary rounded-full" style={{ width: `${task.progress}%` }} /></div>
                                <span className="text-xs text-muted-foreground w-8 text-right">{task.progress}%</span>
                              </div>
                            )}
                          </div>
                          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                        </motion.button>
                      ))}
                    </div>
                  )}
                  {doneDayTasks.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">{t('view.completed')} — {doneDayTasks.length}</p>
                      {doneDayTasks.map((task, i) => (
                        <motion.button key={task.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, duration: 0.2 }}
                          onClick={() => setRepeatTask(task)}
                          className="w-full text-left bg-muted/40 border border-border/60 rounded-xl px-3 py-3 flex items-start gap-3 hover:border-primary/30 hover:bg-muted/60 transition-all active:scale-[0.99] group">
                          <CheckCircle2 className="mt-0.5 w-4 h-4 text-emerald-500 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-muted-foreground leading-snug line-through">{task.title}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {task.tag && <span className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" />{task.tag}</span>}
                              <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{task.estimateMinutes}m</span>
                            </div>
                          </div>
                          <span className="text-xs text-primary font-semibold flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5">
                            <RotateCcw className="w-3.5 h-3.5" />{t('task.repeat')}
                          </span>
                        </motion.button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

// --- Account Page ---

function AccountPage({ email, accentTheme, onAccentThemeChange, onClose, onLogout }: {
  email: string;
  accentTheme: AccentTheme;
  onAccentThemeChange: (theme: AccentTheme) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const { t, i18n } = useTranslation();
  const displayName = email.split('@')[0];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 bg-background flex flex-col items-center overflow-hidden"
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-0 left-4 w-9 h-9 flex items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
        style={{ top: 'max(1.5rem, env(safe-area-inset-top))' }}
      >
        <X className="w-5 h-5" />
      </button>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 w-full max-w-md">
        {/* Avatar */}
        <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center mb-6">
          <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='1.5'%3E%3Cpath d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'/%3E%3Ccircle cx='12' cy='7' r='4'/%3E%3C/svg%3E"
            alt="Avatar" className="w-10 h-10 opacity-50" />
        </div>

        {/* Username */}
        <h2 className="text-xl font-bold text-foreground mb-1">{displayName}</h2>
        <p className="text-sm text-muted-foreground mb-8">{email}</p>

        {/* Settings */}
        <div className="w-full space-y-5 mb-6">
          {/* Accent color */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('account.accentColor')}</p>
            <div className="grid grid-cols-5 gap-2">
              {(Object.keys(ACCENT_THEME_PRESETS) as AccentTheme[]).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  onClick={() => onAccentThemeChange(theme)}
                  className={cn(
                    'h-10 rounded-xl border transition-all',
                    accentTheme === theme ? 'border-foreground/40 shadow-sm scale-[1.02]' : 'border-border'
                  )}
                  style={{ backgroundColor: ACCENT_THEME_PRESETS[theme].primary }}
                  aria-label={t(`account.accent.${theme}`)}
                  title={t(`account.accent.${theme}`)}
                />
              ))}
            </div>
          </div>

          {/* Language */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('account.language')}</p>
            <div className="flex bg-muted rounded-xl p-1">
              <button
                onClick={() => { i18n.changeLanguage('zh'); try { localStorage.setItem('taskflow_lang', 'zh'); } catch { /**/ } }}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-semibold rounded-lg transition-all ${
                  i18n.language === 'zh' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Globe className="w-4 h-4 flex-shrink-0" />{t('account.chinese')}
              </button>
              <button
                onClick={() => { i18n.changeLanguage('en'); try { localStorage.setItem('taskflow_lang', 'en'); } catch { /**/ } }}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-semibold rounded-lg transition-all ${
                  i18n.language !== 'zh' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Globe className="w-4 h-4 flex-shrink-0" />{t('account.english')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Logout button */}
      <div className="w-full max-w-md px-6 pb-safe mb-6">
        <button
          onClick={onLogout}
          className="w-full py-3.5 bg-destructive/10 text-destructive rounded-xl font-semibold text-base hover:bg-destructive/20 transition-colors active:scale-95"
        >
          {t('account.signOut')}
        </button>
      </div>
    </motion.div>
  );
}

// --- Main App ---

// AppShell contains all hooks — must never be rendered conditionally to satisfy Rules of Hooks
function AppShell({
  email,
  accentTheme,
  onAccentThemeChange,
  onLogout,
}: {
  email: string;
  accentTheme: AccentTheme;
  onAccentThemeChange: (theme: AccentTheme) => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<Task[]>(() => loadTasks());
  const [streak, setStreak] = useState(() => loadStatsFromCache().streak);
  const [completedToday, setCompletedToday] = useState(() => loadStatsFromCache().completedToday);
  const completedTodayRef = React.useRef(completedToday);
  completedTodayRef.current = completedToday;
  const hasInteractedRef = React.useRef(false);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [exitAction, setExitAction] = useState<ExitAction | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('flow');
  const greeting = useMemo(() => getGreeting(t), [t]);
  const [isReordering, setIsReordering] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const [isAddingTask, setIsAddingTask] = useState(false);
  const [isRepeatMode, setIsRepeatMode] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [showTaskOptions, setShowTaskOptions] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'offline' | 'error'>('idle');
  const [form, setForm] = useState<AddTaskState>(DEFAULT_FORM);

  // On mount: pull all tasks from cloud (cloud-primary), fall back to cache
  useEffect(() => {
    let cancelled = false;
    async function init() {
      let serverReachable = false;
      try {
        const remote = await apiGetTasks();
        if (!cancelled) {
          serverReachable = true;
          const remoteTasks: Task[] = remote.map(t => ({
            id: t.id, title: t.title, priority: t.priority as Priority,
            estimateMinutes: t.estimateMinutes, status: t.status as TaskStatus,
            tag: t.tag ?? undefined, progress: t.progress, dueDate: t.dueDate,
            reminderAt: t.reminderAt, repeatRule: (t.repeatRule as Task['repeatRule']) ?? 'none',
            deletedAt: t.deletedAt, sortOrder: t.sortOrder, _dirty: false,
          }));

          // Preserve dirty tasks from cache that haven't reached the server yet
          const cached = loadTasks();
          const remoteIds = new Set(remoteTasks.map(t => t.id));
          const dirtyTasks = cached.filter(t => t._dirty && !remoteIds.has(t.id));

          const merged = [...remoteTasks, ...dirtyTasks];
          setTasks(merged);
          saveTasksToCache(merged);
          saveSyncMeta({ lastSync: new Date().toISOString() });
        }
      } catch {
        console.warn('TaskFlow: server unreachable, using cached data');
      }

      if (cancelled) return;

      // If offline, use cached tasks
      if (!serverReachable) {
        const cached = loadTasks();
        setTasks(cached.length > 0 ? cached : []);
      }

      // Stats — cache is the authority for streak; server is a mirror
      try {
        const cached = loadStatsFromCache();
        if (!cancelled && !hasInteractedRef.current) {
          setStreak(cached.streak);
          setCompletedToday(cached.completedToday);
        }

        // Background: sync with server (only populate cache, don't overwrite state)
        if (serverReachable) {
          apiGetUserStats().then(stats => {
            if (!hasInteractedRef.current && cached.streak === 0) {
              // First-ever login — sync initial streak from server
              setStreak(stats.streak);
              setCompletedToday(stats.todayCount);
            }
            saveStatsToCache(stats.streak, stats.todayCount, stats.streakDate);
          }).catch(() => {});
        }
      } catch {
        // Non-critical — cache already loaded above
      }
      if (!cancelled) setTasksLoading(false);
    }
    init();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On native cold-start, restore data from Capacitor Preferences if localStorage was cleared
  useEffect(() => {
    const STORAGE_KEYS = ['taskflow_tasks', 'taskflow_streak', 'taskflow_completed_today'];
    restoreFromNativeStorage(STORAGE_KEYS).then(() => {
      // Re-read from localStorage into state; if API already loaded, don't overwrite
      setTasks(prev => prev.length === 0 ? loadTasks() : prev);
      const cached = loadStatsFromCache();
      setStreak(prev => prev === 0 ? cached.streak : prev);
      setCompletedToday(prev => prev === 0 ? cached.completedToday : prev);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isAddingTask) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeTaskForm(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAddingTask]);

  // Cache tasks to localStorage whenever they change
  useEffect(() => { saveTasksToCache(tasks); }, [tasks]);

  const retryDirtyTasks = React.useCallback(async () => {
    const dirty = loadTasks().filter(t => t._dirty);
    if (dirty.length === 0) {
      setSyncStatus(navigator.onLine ? 'idle' : 'offline');
      return;
    }
    if (!navigator.onLine) {
      setSyncStatus('offline');
      return;
    }
    setSyncStatus('syncing');
    const flushed = await flushDirtyTasks(loadTasks());
    setTasks(flushed);
    const stillDirty = flushed.some(t => t._dirty);
    setSyncStatus(stillDirty ? 'error' : 'idle');
  }, []);

  useEffect(() => {
    retryDirtyTasks();
    const handleOnline = () => retryDirtyTasks();
    const handleOffline = () => setSyncStatus('offline');
    const handleFocus = () => retryDirtyTasks();
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleFocus);
    };
  }, [retryDirtyTasks]);

  const activeTasks = tasks.filter(t => !t.deletedAt);
  const pendingTasks = activeTasks.filter(t => t.status === 'todo');

  const handleProgressChange = (id: string, newProgress: number) => {
    setTasks(prev => {
      const updated = prev.map(t => t.id === id ? { ...t, progress: newProgress } : t);
      return markDirty(updated, id);
    });
    // Background push
    apiUpdateTask(id, { progress: newProgress })
      .then(() => setTasks(prev => markClean(prev, id)))
      .catch(() => toast.error(t('sync.error')));
  };

  const handleAction = (id: string, action: ExitAction) => {
    hasInteractedRef.current = true;
    if (action === 'snooze') {
      setExitAction('snooze');
      setTimeout(() => {
        setTasks(prev => {
          const task = prev.find(t => t.id === id);
          if (!task) return prev;
          return markDirty([...prev.filter(t => t.id !== id), task], id);
        });
        setExitAction(null);
        apiUpdateTask(id, { status: 'snoozed' })
          .then(() => setTasks(prev => markClean(prev, id)))
          .catch(() => toast.error(t('sync.error')));
      }, 320);
    } else {
      setExitAction(action);
      const newStatus = action === 'complete' ? 'done' : 'skipped';
      setTimeout(() => {
        setTasks(prev => {
          const task = prev.find(t => t.id === id);
          const updated = prev.map(t => t.id !== id ? t : { ...t, status: newStatus as TaskStatus });
          if (action !== 'complete' || !task) return markDirty(updated, id);
          const nextDueDate = nextRepeatDate(task.dueDate, task.repeatRule);
          if (!nextDueDate) return markDirty(updated, id);
          const nextTask: Task = {
            ...task,
            id: Math.random().toString(36).substring(7),
            status: 'todo',
            progress: 0,
            dueDate: nextDueDate,
            reminderAt: null,
            deletedAt: null,
            sortOrder: updated.filter(t => t.status === 'todo' && !t.deletedAt).length,
            _dirty: true,
          };
          return markDirty([...updated, nextTask], id);
        });
        apiUpdateTask(id, { status: newStatus })
          .then(() => setTasks(prev => markClean(prev, id)))
          .catch(() => toast.error(t('sync.error')));
        if (action === 'complete') {
          // Haptic feedback (silently ignored in browser)
          Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});

          const newCount = completedTodayRef.current + 1;
          setCompletedToday(newCount);

          // Compute streak locally: if first completion today, check continuity
          let newStreak = streak; // default: same as current
          if (completedTodayRef.current === 0) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yStr = yesterday.toISOString().split('T')[0];
            try {
              const raw = storageGet('taskflow_streak');
              if (raw) {
                const { count, lastDate } = JSON.parse(raw) as { count: number; lastDate: string };
                newStreak = lastDate === yStr ? count + 1 : 1;
              } else {
                newStreak = 1;
              }
            } catch { newStreak = 1; }
            setStreak(newStreak);
            saveStatsToCache(newStreak, newCount);
          } else {
            saveStatsToCache(streak, newCount);
          }

          // Push to server (server stores what client computed)
          apiUpdateUserStats({ todayCount: newCount, streak: newStreak }).catch(() =>
            toast.error('Stats sync failed — retrying')
          );
        }
      }, 50);
    }
  };

  /** Apply reordered pending tasks back into the full tasks array */
  const handleSaveOrder = (newPendingOrder: Task[]) => {
    setTasks(prev => {
      const nonPending = prev.filter(t => t.status !== 'todo');
      const ids = new Set(newPendingOrder.map(t => t.id));
      return [...newPendingOrder, ...nonPending].map(t => ids.has(t.id) ? { ...t, _dirty: true } : t);
    });
    const order = newPendingOrder.map((t, i) => ({ id: t.id, sortOrder: i }));
    apiReorderTasks(order)
      .then(() => {
        const ids = new Set(newPendingOrder.map(t => t.id));
        setTasks(prev => prev.map(t => ids.has(t.id) ? { ...t, _dirty: false } : t));
      })
      .catch(() => toast.error('Reorder sync failed — retrying'));
  };

  const persistTaskUpdate = (id: string, data: Partial<Task>) => {
    setSyncStatus(navigator.onLine ? 'syncing' : 'offline');
    apiUpdateTask(id, {
      title: data.title,
      priority: data.priority,
      estimateMinutes: data.estimateMinutes,
      status: data.status,
      tag: data.tag,
      progress: data.progress,
      dueDate: data.dueDate,
      reminderAt: data.reminderAt,
      repeatRule: data.repeatRule,
      deletedAt: data.deletedAt,
      sortOrder: data.sortOrder,
    }).then(() => {
      setTasks(prev => markClean(prev, id));
      setSyncStatus('idle');
    }).catch(() => {
      setSyncStatus(navigator.onLine ? 'error' : 'offline');
      toast.error(t('sync.error'));
    });
  };

  const closeTaskForm = () => {
    setIsAddingTask(false);
    setIsRepeatMode(false);
    setEditingTaskId(null);
    setShowTaskOptions(false);
    setForm(DEFAULT_FORM);
  };

  const openEditTask = (task: Task) => {
    setForm({
      title: task.title,
      minutes: String(task.estimateMinutes),
      priority: task.priority,
      dueDate: task.dueDate || '',
      reminderAt: task.reminderAt || '',
      repeatRule: task.repeatRule || 'none',
      tag: task.tag || PRESET_TAGS[0],
    });
    setEditingTaskId(task.id);
    setIsRepeatMode(false);
    setShowTaskOptions(true);
    setIsAddingTask(true);
  };

  const handleDeleteTask = (task: Task) => {
    const deletedAt = new Date().toISOString();
    setTasks(prev => markDirty(prev.map(t => t.id === task.id ? { ...t, deletedAt } : t), task.id));
    persistTaskUpdate(task.id, { deletedAt });
    toast(t('task.deleted'), {
      action: {
        label: t('task.undo'),
        onClick: () => {
          setTasks(prev => markDirty(prev.map(t => t.id === task.id ? { ...t, deletedAt: null } : t), task.id));
          persistTaskUpdate(task.id, { deletedAt: null });
        },
      },
    });
  };

  const handleRepeatTask = (task: Task) => {
    setForm({
      title: task.title,
      minutes: String(task.estimateMinutes),
      priority: task.priority,
      dueDate: '',
      reminderAt: '',
      repeatRule: task.repeatRule || 'none',
      tag: task.tag || PRESET_TAGS[0],
    });
    setIsRepeatMode(true);
    setEditingTaskId(null);
    setShowTaskOptions(true);
    setIsAddingTask(true);
  };

  const openAddTask = () => { setForm(DEFAULT_FORM); setIsRepeatMode(false); setEditingTaskId(null); setShowTaskOptions(false); setIsAddingTask(true); };

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    if (editingTaskId) {
      const patch: Partial<Task> = {
        title: form.title.trim(),
        priority: form.priority,
        estimateMinutes: parseInt(form.minutes) || 15,
        dueDate: form.dueDate || null,
        reminderAt: form.reminderAt || null,
        repeatRule: form.repeatRule,
        tag: form.tag,
      };
      setTasks(prev => markDirty(prev.map(t => t.id === editingTaskId ? { ...t, ...patch } : t), editingTaskId));
      persistTaskUpdate(editingTaskId, patch);
      closeTaskForm();
      return;
    }
    const tempId = Math.random().toString(36).substring(7);

    const idx = insertIndex(tasks, { id: tempId, title: '', priority: form.priority, estimateMinutes: 0, status: 'todo', progress: 0, dueDate: form.dueDate || null, sortOrder: 0 } as Task);

    const optimisticTask: Task = {
      id: tempId, _dirty: true,
      title: form.title, priority: form.priority,
      estimateMinutes: parseInt(form.minutes) || 15,
      status: 'todo', progress: 0,
      dueDate: form.dueDate || null, reminderAt: form.reminderAt || null,
      repeatRule: form.repeatRule, deletedAt: null, tag: form.tag,
      sortOrder: idx,
    };
    setTasks(prev => {
      const i = insertIndex(prev, optimisticTask);
      return [...prev.slice(0, i), optimisticTask, ...prev.slice(i)];
    });
    closeTaskForm();
    // Background push
    apiCreateTask({
      title: optimisticTask.title, priority: optimisticTask.priority,
      estimateMinutes: optimisticTask.estimateMinutes,
      status: optimisticTask.status, tag: optimisticTask.tag,
      progress: optimisticTask.progress, dueDate: optimisticTask.dueDate,
      reminderAt: optimisticTask.reminderAt, repeatRule: optimisticTask.repeatRule,
      sortOrder: optimisticTask.sortOrder,
    }).then(created => {
      setTasks(prev => markClean(prev.map(t => t.id === tempId ? { ...t, id: created.id } : t), created.id));
      setSyncStatus('idle');
    }).catch((e) => {
      setSyncStatus(navigator.onLine ? 'error' : 'offline');
      toast.error(t('sync.error'));
    });
  };
  
  return (
    <div className="app-viewport app-safe-y bg-background text-foreground flex flex-col items-center overscroll-none selection:bg-primary/20">

      {/* Account Page */}
      <AnimatePresence>
        {accountOpen && (
          <AccountPage
            email={email}
            accentTheme={accentTheme}
            onAccentThemeChange={onAccentThemeChange}
            onClose={() => setAccountOpen(false)}
            onLogout={onLogout}
          />
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="w-full max-w-md px-4 sm:px-6 flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-normal">{greeting}</h1>
          <p className="text-muted-foreground text-sm flex items-center gap-1.5 mt-1">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span>{t('task.tasksDoneToday', { count: completedToday })}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 bg-card border border-border px-3 py-1.5 rounded-full shadow-sm">
            <Flame className="w-4 h-4 text-orange-500" fill="currentColor" />
            <span className="text-sm font-semibold">{t('stats.streakDays', { count: streak })}</span>
          </div>
          <button
            onClick={() => setAccountOpen(true)}
            title="Account"
            className="w-9 h-9 flex items-center justify-center rounded-full bg-muted hover:bg-muted/80 transition-colors overflow-hidden"
          >
            <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'/%3E%3Ccircle cx='12' cy='7' r='4'/%3E%3C/svg%3E"
              alt="User" className="w-5 h-5 opacity-60" />
          </button>
        </div>
      </header>

      {syncStatus !== 'idle' && (
        <div className="w-full max-w-md px-4 sm:px-6 mb-3">
          <button
            onClick={retryDirtyTasks}
            className={`w-full flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
              syncStatus === 'error'
                ? 'border-destructive/30 bg-destructive/10 text-destructive'
                : 'border-border bg-card text-muted-foreground'
            }`}
          >
            <RotateCw className={`w-3.5 h-3.5 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
            {t(`sync.${syncStatus}`)}
          </button>
        </div>
      )}

      {/* Toast notifications */}
      <Toaster />

      {/* View Toggle */}
      <div className="w-full max-w-md px-4 sm:px-6 flex justify-center mb-5">
        <ViewToggle view={viewMode} onChange={setViewMode} />
      </div>

      {/* Loading state */}
      {tasksLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
      {/*
       * Sliding container: both views rendered side-by-side, container translates
       * to reveal the active panel. Eliminates AnimatePresence exit/enter timing
       * issues and produces perfectly smooth transitions in both directions.
       */}
      <div className="w-full max-w-md overflow-x-hidden flex-1 overflow-hidden relative">
        <motion.div
          className="flex items-stretch h-full"
          style={{ width: '200%', willChange: 'transform' }}
          animate={{ x: viewMode === 'flow' ? '0%' : '-50%' }}
          initial={false}
          transition={{ type: 'spring', stiffness: 360, damping: 36, mass: 0.85 }}
        >
          {/* ── Flow panel ── */}
          <div className="flex flex-col items-center px-4 sm:px-6 pb-4 h-full" style={{ width: '50%' }}>
            {pendingTasks.length > 0 ? (
              <>
                <div className="relative w-full aspect-[4/5] max-w-[360px] mt-2">
                  <AnimatePresence custom={exitAction} mode="popLayout">
                    {pendingTasks.slice(0, 3).map((task, index) => {
                      const isTop = index === 0;
                      return (
                        <motion.div
                          key={task.id}
                          layout
                          custom={exitAction}
                          initial={{ opacity: 0, y: 50, scale: 0.9 }}
                          animate={{
                            opacity: index > 1 ? 0 : 1 - index * 0.15,
                            y: index * 16,
                            scale: 1 - index * 0.04,
                            zIndex: 10 - index,
                          }}
                          exit={(custom) => ({
                            opacity: 0,
                            y: custom === 'complete' ? -150 : custom === 'skip' ? 150 : 50,
                            x: custom === 'skip' ? -100 : custom === 'snooze' ? 100 : 0,
                            rotate: custom === 'complete' ? 5 : custom === 'skip' ? -8 : 8,
                            scale: 0.9,
                            transition: { duration: 0.3, ease: 'easeOut' }
                          })}
                          transition={{ type: 'spring', stiffness: 300, damping: 25, mass: 0.8 }}
                          className={`absolute inset-0 w-full h-full ${!isTop ? 'pointer-events-none' : ''}`}
                        >
                          <TaskCard task={task} onAction={handleAction} onProgressChange={handleProgressChange} exitAction={exitAction} />
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>

                {/* Up next + reorder button */}
                <div className="w-full max-w-sm mt-6 bg-card border border-border rounded-2xl p-3 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase text-muted-foreground">{t('task.upNext')}</span>
                    <button
                      onClick={() => setIsReordering(true)}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors bg-muted hover:bg-muted/80 px-2.5 py-1.5 rounded-lg font-semibold"
                    >
                      <ArrowUpDown className="w-3.5 h-3.5" />{t('task.reorder')}
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {pendingTasks.slice(1, 4).map(task => (
                      <div key={task.id} className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-2">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT_COLOR[task.priority]}`} />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{task.title}</span>
                        <span className="text-xs text-muted-foreground">{task.estimateMinutes}m</span>
                      </div>
                    ))}
                    {pendingTasks.length === 1 && (
                      <p className="rounded-lg bg-muted/50 px-2.5 py-2 text-sm text-muted-foreground">{t('task.noMoreTasks')}</p>
                    )}
                  </div>
                </div>

                {/* Hint */}
                <div className="w-full max-w-sm mt-3 px-1 flex gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><AlarmClock className="w-3 h-3" />{t('task.snoozeHint')}</span>
                  <span className="flex items-center gap-1"><SkipForward className="w-3 h-3" />{t('task.skipHint')}</span>
                </div>
              </>
            ) : (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center justify-center h-full w-full max-w-sm text-center px-6">
                <div className="w-16 h-16 bg-muted text-muted-foreground rounded-2xl flex items-center justify-center mb-5">
                  <CheckCircle2 className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-semibold mb-2">{t('task.allCaughtUp')}</h2>
                <p className="text-sm text-muted-foreground mb-7">{t('task.allCaughtUpDesc')}</p>
                <button onClick={openAddTask} className="w-full py-3 bg-primary text-primary-foreground font-semibold rounded-xl">{t('task.addNewTask')}</button>
              </motion.div>
            )}
          </div>

          {/* ── Calendar panel ── */}
          <div className="flex flex-col items-center px-4 sm:px-6 pb-4 h-full overflow-y-auto" style={{ width: '50%' }}>
            <CalendarView
              tasks={activeTasks}
              onAction={handleAction}
              onProgressChange={handleProgressChange}
              onAddTask={openAddTask}
              onRepeatTask={handleRepeatTask}
            />
          </div>
        </motion.div>
      </div>

      {/* Reorder Sheet */}
      <ReorderSheet
        isOpen={isReordering}
        pendingTasks={pendingTasks}
        onClose={() => setIsReordering(false)}
        onSave={handleSaveOrder}
      />
      </>
      )}

      {/* FAB */}
      <button
        onClick={openAddTask}
        className="fixed bottom-safe right-6 sm:right-8 w-12 h-12 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-lg shadow-primary/20 hover:bg-primary/90 transition-transform active:scale-95 z-40"
      >
        <Plus className="w-6 h-6" />
      </button>

      {/* Add Task centered card */}
      <AnimatePresence>
        {isAddingTask && (
          <>
            {/* Backdrop */}
            <motion.div
              key="add-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 backdrop-blur-md z-50"
              onClick={closeTaskForm}
            />
            {/* Card */}
            <motion.div
              key="add-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-task-title"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30, mass: 0.8 }}
              style={{ willChange: 'transform' }}
              className="fixed left-[50%] top-[50%] z-50 w-full max-w-[360px] translate-x-[-50%] translate-y-[-50%] bg-card rounded-2xl border border-border shadow-xl flex flex-col"
            >
              {/* Header */}
              <div className="flex items-start justify-between px-6 pt-6 pb-4">
                <div>
                  <h2 id="add-task-title" className="text-lg font-bold">{editingTaskId ? t('task.editTask') : isRepeatMode ? t('task.repeatModeTitle') : t('task.addToFlow')}</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {form.title ? t('task.editPrompt') : t('task.addPrompt')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeTaskForm}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-muted/80 transition-colors flex-shrink-0 ml-3 mt-0.5"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Form body */}
              <form onSubmit={handleAddTask} className="overflow-y-auto px-6 pb-6 space-y-4" style={{ maxHeight: 'calc(75vh - 80px)' }}>
                <div className="space-y-2">
                  <label htmlFor="title" className="text-sm font-medium leading-none">{t('task.taskName')}</label>
                  <input id="title" type="text" autoFocus placeholder={t('task.titlePlaceholder')}
                    className="flex h-11 w-full rounded-xl border border-input bg-input-background px-3 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={form.title} onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))} required />
                </div>

                <div className="space-y-2">
                  <label htmlFor="dueDate" className="text-sm font-medium leading-none">{t('task.deadline')}</label>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { key: 'today', offset: 0 },
                      { key: 'tomorrow', offset: 1 },
                      { key: 'week', offset: 7 },
                      { key: 'none', offset: null },
                    ].map(item => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => {
                          if (item.offset === null) {
                            setForm(f => ({ ...f, dueDate: '' }));
                            return;
                          }
                          const next = new Date();
                          next.setDate(next.getDate() + item.offset);
                          setForm(f => ({ ...f, dueDate: fmtDate(next.getFullYear(), next.getMonth(), next.getDate()) }));
                        }}
                        className={`rounded-lg border px-2 py-1.5 text-xs font-semibold active:scale-95 ${
                          item.offset === null
                            ? form.dueDate === '' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted text-muted-foreground'
                            : 'border-border bg-muted text-muted-foreground'
                        }`}
                      >
                        {t(`task.quickDate.${item.key}`)}
                      </button>
                    ))}
                  </div>
                  <input id="dueDate" type="date"
                    className="flex h-10 w-full appearance-none rounded-xl border border-input bg-input-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={form.dueDate} onChange={(e) => setForm(f => ({ ...f, dueDate: e.target.value }))} />
                </div>

                <div className="space-y-2">
                  <label htmlFor="priority" className="text-sm font-medium leading-none">{t('task.priority')}</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['P1', 'P2', 'P3'] as Priority[]).map(priority => (
                      <button
                        key={priority}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, priority }))}
                        className={`rounded-xl border px-2 py-2 text-xs font-semibold transition-colors ${
                          form.priority === priority
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-border bg-muted text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {t(PRIORITY_LABEL_KEY[priority])}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setShowTaskOptions(v => !v)}
                  className="flex w-full items-center justify-between rounded-xl border border-border bg-muted/50 px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
                >
                  <span>{t('task.moreOptions')}</span>
                  <ChevronRight className={`w-4 h-4 transition-transform ${showTaskOptions ? 'rotate-90' : ''}`} />
                </button>

                <AnimatePresence initial={false}>
                  {showTaskOptions && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                      className="overflow-hidden"
                    >
                      <div className="space-y-4 pt-1">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <label htmlFor="minutes" className="text-sm font-medium leading-none">{t('task.estMinutes')}</label>
                            <input id="minutes" type="number" min="1"
                              className="flex h-10 w-full rounded-xl border border-input bg-input-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              value={form.minutes} onChange={(e) => setForm(f => ({ ...f, minutes: e.target.value }))} />
                          </div>
                          <div className="space-y-2">
                            <label htmlFor="tag" className="text-sm font-medium leading-none">{t('task.categoryTag')}</label>
                            <select id="tag"
                              className="flex h-10 w-full rounded-xl border border-input bg-input-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              value={form.tag} onChange={(e) => setForm(f => ({ ...f, tag: e.target.value }))}>
                              {PRESET_TAGS.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                            </select>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <label htmlFor="reminderAt" className="text-sm font-medium leading-none flex items-center gap-1.5"><Bell className="w-4 h-4" />{t('task.reminderAt')}</label>
                          <input id="reminderAt" type="datetime-local"
                            className="flex h-10 w-full appearance-none rounded-xl border border-input bg-input-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            value={form.reminderAt} onChange={(e) => setForm(f => ({ ...f, reminderAt: e.target.value }))} />
                        </div>
                        <div className="space-y-2">
                          <label htmlFor="repeatRule" className="text-sm font-medium leading-none">{t('task.repeatRule')}</label>
                          <select id="repeatRule"
                            className="flex h-10 w-full rounded-xl border border-input bg-input-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            value={form.repeatRule} onChange={(e) => setForm(f => ({ ...f, repeatRule: e.target.value as AddTaskState['repeatRule'] }))}>
                            <option value="none">{t('task.repeatRules.none')}</option>
                            <option value="daily">{t('task.repeatRules.daily')}</option>
                            <option value="weekly">{t('task.repeatRules.weekly')}</option>
                            <option value="monthly">{t('task.repeatRules.monthly')}</option>
                          </select>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Actions */}
                <div className="flex flex-col gap-3 pt-1">
                  <button type="submit" className="w-full py-3.5 bg-primary text-primary-foreground rounded-xl font-semibold text-base hover:bg-primary/90 transition-colors active:scale-95">
                    {editingTaskId ? t('task.saveChanges') : isRepeatMode ? t('task.addRepeatedTask') : t('task.addTask')}
                  </button>
                  <button type="button" onClick={closeTaskForm}
                    className="w-full py-3 bg-muted text-muted-foreground rounded-xl text-sm font-medium hover:bg-muted/80 transition-colors active:scale-95">
                    {t('task.cancel')}
                  </button>
                </div>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// App handles auth state only; AppShell holds all hooks (Rules of Hooks compliance)
export default function App() {
  // 'loading' = checking refresh cookie, 'auth' = not logged in, 'app' = logged in
  const [appState, setAppState] = useState<'loading' | 'auth' | 'app'>('loading');
  const [userEmail, setUserEmail] = useState(() => loadSession()?.email || '');
  const [accentTheme, setAccentTheme] = useState<AccentTheme>('lavender');
  const [accentThemeReady, setAccentThemeReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function initAccentTheme() {
      await restoreFromNativeStorage([ACCENT_THEME_KEY]);
      if (cancelled) return;
      setAccentTheme(loadAccentTheme());
      setAccentThemeReady(true);
    }
    initAccentTheme();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!accentThemeReady) return;
    applyAccentTheme(accentTheme);
    storageSet(ACCENT_THEME_KEY, accentTheme);
  }, [accentTheme, accentThemeReady]);

  // Keep a stable app viewport height across iOS toolbar/safe-area changes.
  useEffect(() => {
    const forceStableHeight = appState !== 'app';
    const updateViewportHeight = () => {
      syncAppViewportHeight(forceStableHeight);
    };

    updateViewportHeight();
    const viewport = window.visualViewport;
    window.addEventListener('resize', updateViewportHeight);
    window.addEventListener('orientationchange', updateViewportHeight);
    viewport?.addEventListener('resize', updateViewportHeight);
    viewport?.addEventListener('scroll', updateViewportHeight);

    return () => {
      window.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('orientationchange', updateViewportHeight);
      viewport?.removeEventListener('resize', updateViewportHeight);
      viewport?.removeEventListener('scroll', updateViewportHeight);
    };
  }, [appState]);

  // Re-sync viewport after auth/loading → app transition to avoid iOS keyboard carryover.
  useEffect(() => {
    if (appState !== 'app') return;
    const runForced = () => syncAppViewportHeight(true);
    const runDynamic = () => syncAppViewportHeight(false);
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    runForced();
    const t1 = window.setTimeout(runForced, 120);
    const t2 = window.setTimeout(runDynamic, 320);
    const t3 = window.setTimeout(runDynamic, 800);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [appState]);

  // Register a global auth-failure callback so apiFetch can trigger logout
  useEffect(() => {
    setAuthFailureHandler(() => {
      clearLocalAuthTokens();
      clearSession();
      setUserEmail('');
      setAppState('auth');
    });
    return () => setAuthFailureHandler(null);
  }, []);

  // On mount: restore native storage, then restore the access token using the refresh cookie/token.
  useEffect(() => {
    if (appState !== 'loading') return;
    let cancelled = false;
    async function restoreSession() {
      await restoreFromNativeStorage([SESSION_KEY, 'taskflow_logged_in', 'taskflow_user_email', 'taskflow_refresh_token', ACCENT_THEME_KEY]);
      if (cancelled) return;

      const session = loadSession();
      const legacyEmail = storageGet('taskflow_user_email') || '';
      const canUseSession = !!session && !session.signedOut && !isSessionExpired(session);
      const emailForRestore = session?.email || legacyEmail;

      // If user explicitly logged out or session is invalid, skip refresh and go to auth
      if (!canUseSession && session?.signedOut) {
        clearLocalAuthTokens();
        setAppState('auth');
        return;
      }

      const refreshResult = await apiRefreshDetailed();
      if (cancelled) return;
      if (refreshResult === 'ok') {
        if (emailForRestore) saveSession(emailForRestore);
        setUserEmail(emailForRestore);
        setAppState('app');
        return;
      }
      if (refreshResult === 'network' && canUseSession) {
        setUserEmail(emailForRestore);
        setAppState('app');
        return;
      }
      clearLocalAuthTokens();
      clearSession();
      setAppState('auth');
    }
    restoreSession();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleAuth(email: string) {
    (document.activeElement as HTMLElement | null)?.blur();
    syncAppViewportHeight(true);
    setUserEmail(email);
    saveSession(email);
    setAppState('app');
  }

  async function handleLogout() {
    // Flush dirty tasks to cloud before logout
    try {
      const raw = storageGet('taskflow_tasks');
      if (raw) {
        const tasks = JSON.parse(raw) as Task[];
        await flushDirtyTasks(tasks);
      }
      // Push current stats
      const stats = loadStatsFromCache();
      try { await apiUpdateUserStats({ todayCount: stats.completedToday }); } catch { /* */ }
    } catch { /* non-critical */ }

    try { await apiLogout(); } catch { /* still clean up locally */ }
    // Wipe local database (always, even if network logout fails)
    storageRemove('taskflow_tasks');
    storageRemove('taskflow_streak');
    storageRemove('taskflow_completed_today');
    storageRemove(SYNC_META_KEY);
    clearSession();
    clearLocalAuthTokens();
    setAppState('auth');
    setUserEmail('');
  }

  if (appState === 'loading') {
    return (
      <div className="app-viewport app-safe-y bg-background flex items-center justify-center overscroll-none">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (appState === 'auth') {
    return <AuthPage onAuth={handleAuth} />;
  }

  return (
    <AppShell
      email={userEmail}
      accentTheme={accentTheme}
      onAccentThemeChange={setAccentTheme}
      onLogout={handleLogout}
    />
  );
}
