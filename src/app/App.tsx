import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, Reorder, useDragControls } from 'motion/react';
import {
  Check, X, Clock, Plus, Flame, CheckCircle2,
  Calendar, Tag, XCircle, ChevronLeft, ChevronRight,
  ListTodo, SkipForward, AlarmClock, RotateCcw,
  GripVertical, ArrowUpDown
} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { storageGet, storageSet, restoreFromNativeStorage } from './storage';

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
}

// --- Constants ---
const PRESET_TAGS = ['Work', 'Personal', 'Study', 'Planning', 'Health', 'Other'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const PRIORITY_BADGE = {
  P1: 'text-rose-600 bg-rose-100 dark:bg-rose-900/30 dark:text-rose-400',
  P2: 'text-amber-600 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400',
  P3: 'text-emerald-600 bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400',
};
const PRIORITY_LABEL = { P1: 'High Priority', P2: 'Medium Priority', P3: 'Low Priority' };
const DOT_COLOR = { P1: 'bg-rose-500', P2: 'bg-amber-400', P3: 'bg-emerald-500' };

function loadTasks(): Task[] {
  try {
    const raw = storageGet('taskflow_tasks');
    if (raw) return JSON.parse(raw) as Task[];
  } catch { /**/ }
  return [];
}

function saveTasks(tasks: Task[]) {
  try {
    storageSet('taskflow_tasks', JSON.stringify(tasks));
  } catch { /**/ }
}

// --- Persistence helpers ---
const todayStr = () => new Date().toISOString().split('T')[0];

function loadStreak(): number {
  try {
    const raw = storageGet('taskflow_streak');
    if (!raw) return 0;
    const { count, lastDate } = JSON.parse(raw) as { count: number; lastDate: string };
    const today = todayStr();
    if (lastDate === today) return count;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (lastDate === yesterday.toISOString().split('T')[0]) return count;
    return 0;
  } catch { return 0; }
}

function recordCompletion(): { streak: number; completedToday: number } {
  const today = todayStr();
  let completedToday = 0;
  try {
    const raw = storageGet('taskflow_completed_today');
    if (raw) { const { date, count } = JSON.parse(raw); completedToday = date === today ? count : 0; }
  } catch { /**/ }
  completedToday += 1;
  storageSet('taskflow_completed_today', JSON.stringify({ date: today, count: completedToday }));

  let streak = 0;
  try {
    const raw = storageGet('taskflow_streak');
    if (raw) {
      const { count, lastDate } = JSON.parse(raw);
      if (lastDate === today) {
        streak = count;
      } else {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        streak = lastDate === yesterday.toISOString().split('T')[0] ? count + 1 : 1;
        storageSet('taskflow_streak', JSON.stringify({ count: streak, lastDate: today }));
      }
    } else {
      streak = 1;
      storageSet('taskflow_streak', JSON.stringify({ count: 1, lastDate: today }));
    }
  } catch { streak = 1; }
  return { streak, completedToday };
}

function loadCompletedToday(): number {
  try {
    const raw = storageGet('taskflow_completed_today');
    if (!raw) return 0;
    const { date, count } = JSON.parse(raw);
    return date === todayStr() ? count : 0;
  } catch { return 0; }
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 21) return 'Good evening';
  return 'Good night';
}

function fmtDate(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// --- Add Task Form state ---
interface AddTaskState {
  title: string;
  minutes: string;
  priority: Priority;
  dueDate: string;
  tag: string;
}
const DEFAULT_FORM: AddTaskState = { title: '', minutes: '25', priority: 'P2', dueDate: '', tag: PRESET_TAGS[0] };

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
        <span className="relative z-10 flex items-center gap-2"><ListTodo className="w-3.5 h-3.5 flex-shrink-0" />Flow</span>
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
        <span className="relative z-10 flex items-center gap-2"><Calendar className="w-3.5 h-3.5 flex-shrink-0" />Calendar</span>
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
  return (
    <div className="relative w-full h-full bg-card rounded-3xl border border-border flex flex-col overflow-hidden">
      <div
        className="absolute bottom-0 left-0 w-full bg-primary/10 transition-all duration-500 ease-out z-0"
        style={{ height: `${task.progress}%` }}
      >
        {task.progress > 0 && task.progress < 100 && (
          <div className="absolute top-[-20px] left-0 w-[200%] h-[20px] overflow-hidden z-0">
            <svg viewBox="0 0 800 50" preserveAspectRatio="none" className="w-full h-full fill-primary/10 animate-wave">
              <path d="M 0 25 Q 100 50 200 25 T 400 25 Q 500 50 600 25 T 800 25 L 800 50 L 0 50 Z" />
            </svg>
          </div>
        )}
      </div>
      <div className="relative z-10 flex flex-col h-full p-6">
        <div className="flex items-center justify-between mb-6">
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${PRIORITY_BADGE[task.priority]}`}>{PRIORITY_LABEL[task.priority]}</span>
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
              <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">Progress</span>
              <input
                type="range" min="0" max="100" step="5"
                value={task.progress}
                onChange={(e) => onProgressChange(task.id, parseInt(e.target.value))}
                onPointerDown={(e) => e.stopPropagation()}
                className="flex-1 h-1.5 bg-muted rounded-full appearance-none cursor-pointer"
                style={{ accentColor: 'var(--primary)' }}
              />
              <span className="text-sm font-medium text-muted-foreground w-9 text-right">{task.progress}%</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => onAction(task.id, 'snooze')} className="flex items-center justify-center gap-2 bg-secondary/80 backdrop-blur-sm text-secondary-foreground py-3.5 rounded-xl font-semibold transition-transform active:scale-95">
              <AlarmClock className="w-5 h-5" />Snooze
            </button>
            <button onClick={() => onAction(task.id, 'skip')} className="flex items-center justify-center gap-2 bg-muted/80 backdrop-blur-sm text-muted-foreground py-3.5 rounded-xl font-semibold transition-transform active:scale-95 hover:bg-muted">
              <SkipForward className="w-5 h-5" />Skip
            </button>
          </div>
          <button onClick={() => onAction(task.id, 'complete')} className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-4 rounded-xl font-bold text-lg shadow-lg shadow-primary/25 transition-transform active:scale-95 hover:bg-primary/90">
            <Check className="w-6 h-6" />Complete Task
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
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-full max-w-[360px] h-[520px] translate-x-[-50%] translate-y-[-50%] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 rounded-3xl focus:outline-none">
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
            <button className="absolute top-4 right-4 z-20 w-8 h-8 flex items-center justify-center rounded-full bg-black/20 text-white hover:bg-black/30 transition-colors">
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
  return (
    <Dialog.Root open={!!task} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-full max-w-sm translate-x-[-50%] translate-y-[-50%] border border-border bg-card rounded-2xl p-6 shadow-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 focus:outline-none">
          <Dialog.Title className="text-base font-bold mb-1">Completed Task</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground mb-4">This task is done. Want to schedule it again?</Dialog.Description>
          {task && (
            <>
              <div className="bg-muted/50 rounded-xl p-4 mb-5 space-y-2">
                <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />{task.title}
                </p>
                <div className="flex flex-wrap gap-2 ml-6">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${PRIORITY_BADGE[task.priority]}`}>{PRIORITY_LABEL[task.priority]}</span>
                  {task.tag && <span className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" />{task.tag}</span>}
                  <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{task.estimateMinutes}m</span>
                </div>
              </div>
              <div className="flex gap-3">
                <Dialog.Close asChild>
                  <button className="flex-1 py-2.5 bg-muted text-muted-foreground rounded-xl text-sm font-semibold hover:bg-muted/80 transition-colors">Cancel</button>
                </Dialog.Close>
                <button onClick={() => { onRepeat(task); onClose(); }} className="flex-1 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-primary/90 transition-colors active:scale-95">
                  <RotateCcw className="w-4 h-4" />Repeat Task
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
                <h2 className="text-base font-bold">Reorder Tasks</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Drag the handle to rearrange your flow</p>
              </div>
              <button
                onClick={handleDone}
                className="flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-2 rounded-xl text-sm font-semibold active:scale-95 transition-transform"
              >
                <Check className="w-4 h-4" />Done
              </button>
            </div>

            {/* Draggable list */}
            <div className="overflow-y-auto flex-1 px-4 py-3">
              {order.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <CheckCircle2 className="w-10 h-10 text-emerald-500 mb-3" />
                  <p className="text-sm text-muted-foreground">No pending tasks in your flow.</p>
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
                {order.length} task{order.length !== 1 ? 's' : ''} in flow · first card = next to focus
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
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(
    fmtDate(today.getFullYear(), today.getMonth(), today.getDate())
  );
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [repeatTask, setRepeatTask] = useState<Task | null>(null);

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayFmt = fmtDate(today.getFullYear(), today.getMonth(), today.getDate());

  const pendingByDate: Record<string, Task[]> = {};
  tasks.forEach(t => { if (t.dueDate && t.status === 'todo') (pendingByDate[t.dueDate] ??= []).push(t); });

  const allByDate: Record<string, Task[]> = {};
  tasks.forEach(t => { if (t.dueDate) (allByDate[t.dueDate] ??= []).push(t); });

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
      <TaskDetailModal task={detailTask} onClose={() => setDetailTask(null)} onAction={onAction} onProgressChange={onProgressChange} />
      <RepeatTaskModal task={repeatTask} onClose={() => setRepeatTask(null)} onRepeat={onRepeatTask} />

      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center justify-between px-1">
          <button onClick={prevMonth} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"><ChevronLeft className="w-5 h-5" /></button>
          <h2 className="text-base font-bold tracking-tight">{MONTHS[month]} {year}</h2>
          <button onClick={nextMonth} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"><ChevronRight className="w-5 h-5" /></button>
        </div>

        <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
          <div className="grid grid-cols-7 border-b border-border">
            {WEEKDAYS.map(d => <div key={d} className="py-2 text-center text-xs font-semibold text-muted-foreground tracking-wide">{d}</div>)}
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
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500" />High</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400" />Medium</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />Low</span>
          <span className="flex items-center gap-1.5 opacity-50"><span className="w-2 h-2 rounded-full bg-muted-foreground" />Pending only</span>
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
                  {new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </h3>
                <span className="text-xs text-muted-foreground">{dayTasks.length} {dayTasks.length === 1 ? 'task' : 'tasks'}</span>
              </div>

              {dayTasks.length === 0 ? (
                <div className="bg-card border border-border rounded-2xl p-6 flex flex-col items-center gap-3 text-center">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center"><Calendar className="w-5 h-5 text-muted-foreground" /></div>
                  <p className="text-sm text-muted-foreground">No tasks scheduled for this day.</p>
                  <button onClick={onAddTask} className="text-sm font-semibold text-primary flex items-center gap-1 hover:opacity-80 transition-opacity"><Plus className="w-4 h-4" />Add a task</button>
                </div>
              ) : (
                <div className="space-y-4">
                  {pendingDayTasks.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">To Do — {pendingDayTasks.length}</p>
                      {pendingDayTasks.map((task, i) => (
                        <motion.button key={task.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, duration: 0.2 }}
                          onClick={() => setDetailTask(task)}
                          className="w-full text-left bg-card border border-border rounded-xl p-4 flex items-start gap-3 hover:border-primary/40 hover:shadow-sm transition-all active:scale-[0.99]">
                          <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${DOT_COLOR[task.priority]}`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-foreground leading-snug">{task.title}</p>
                            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${PRIORITY_BADGE[task.priority]}`}>{PRIORITY_LABEL[task.priority]}</span>
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
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">Completed — {doneDayTasks.length}</p>
                      {doneDayTasks.map((task, i) => (
                        <motion.button key={task.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, duration: 0.2 }}
                          onClick={() => setRepeatTask(task)}
                          className="w-full text-left bg-muted/40 border border-border/60 rounded-xl p-4 flex items-start gap-3 hover:border-primary/30 hover:bg-muted/60 transition-all active:scale-[0.99] group">
                          <CheckCircle2 className="mt-0.5 w-4 h-4 text-emerald-500 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-muted-foreground leading-snug line-through">{task.title}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {task.tag && <span className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" />{task.tag}</span>}
                              <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{task.estimateMinutes}m</span>
                            </div>
                          </div>
                          <span className="text-xs text-primary font-semibold flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5">
                            <RotateCcw className="w-3.5 h-3.5" />Repeat
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

// --- Main App ---
export default function App() {
  const [tasks, setTasks] = useState<Task[]>(() => loadTasks());
  const [streak, setStreak] = useState(() => loadStreak());
  const [completedToday, setCompletedToday] = useState(() => loadCompletedToday());
  const [exitAction, setExitAction] = useState<ExitAction | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('flow');
  const [greeting] = useState(() => getGreeting());
  const [isReordering, setIsReordering] = useState(false);

  const [isAddingTask, setIsAddingTask] = useState(false);
  const [isRepeatMode, setIsRepeatMode] = useState(false);
  const [form, setForm] = useState<AddTaskState>(DEFAULT_FORM);

  // On native cold-start, restore data from Capacitor Preferences if localStorage was cleared
  useEffect(() => {
    const STORAGE_KEYS = ['taskflow_tasks', 'taskflow_streak', 'taskflow_completed_today'];
    restoreFromNativeStorage(STORAGE_KEYS).then(() => {
      setTasks(loadTasks());
      setStreak(loadStreak());
      setCompletedToday(loadCompletedToday());
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isAddingTask) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setIsAddingTask(false); setIsRepeatMode(false); setForm(DEFAULT_FORM); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isAddingTask]);

  useEffect(() => { saveTasks(tasks); }, [tasks]);

  const pendingTasks = tasks.filter(t => t.status === 'todo');

  const handleProgressChange = (id: string, newProgress: number) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, progress: newProgress } : t));
  };

  const handleAction = (id: string, action: ExitAction) => {
    if (action === 'snooze') {
      setExitAction('snooze');
      setTimeout(() => {
        setTasks(prev => {
          const task = prev.find(t => t.id === id);
          if (!task) return prev;
          return [...prev.filter(t => t.id !== id), task];
        });
        setExitAction(null);
      }, 320);
    } else {
      setExitAction(action);
      setTimeout(() => {
        setTasks(prev => prev.map(t => t.id !== id ? t : { ...t, status: action === 'complete' ? 'done' : 'skipped' }));
        if (action === 'complete') {
          const { streak: s, completedToday: c } = recordCompletion();
          setStreak(s);
          setCompletedToday(c);
        }
      }, 50);
    }
  };

  /** Apply reordered pending tasks back into the full tasks array */
  const handleSaveOrder = (newPendingOrder: Task[]) => {
    setTasks(prev => {
      const nonPending = prev.filter(t => t.status !== 'todo');
      return [...newPendingOrder, ...nonPending];
    });
  };

  const handleRepeatTask = (task: Task) => {
    setForm({ title: task.title, minutes: String(task.estimateMinutes), priority: task.priority, dueDate: '', tag: task.tag || PRESET_TAGS[0] });
    setIsRepeatMode(true);
    setIsAddingTask(true);
  };

  const openAddTask = () => { setForm(DEFAULT_FORM); setIsRepeatMode(false); setIsAddingTask(true); };

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    const newTask: Task = {
      id: Math.random().toString(36).substring(7),
      title: form.title, priority: form.priority,
      estimateMinutes: parseInt(form.minutes) || 15,
      status: 'todo', progress: 0,
      dueDate: form.dueDate || null, tag: form.tag,
    };
    setTasks(prev => {
      const i = insertIndex(prev, newTask);
      return [...prev.slice(0, i), newTask, ...prev.slice(i)];
    });
    setIsAddingTask(false);
    setIsRepeatMode(false);
    setForm(DEFAULT_FORM);
  };

  return (
    <div className="h-screen bg-background text-foreground flex flex-col items-center pt-safe overflow-hidden selection:bg-primary/20">

      {/* Header */}
      <header className="w-full max-w-md px-4 sm:px-6 flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{greeting} 👋</h1>
          <p className="text-muted-foreground text-sm flex items-center gap-1.5 mt-1">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span>{completedToday} {completedToday === 1 ? 'task' : 'tasks'} done today</span>
          </p>
        </div>
        <div className="flex items-center gap-2 bg-card border border-border px-3 py-1.5 rounded-full shadow-sm">
          <Flame className="w-4 h-4 text-orange-500" fill="currentColor" />
          <span className="text-sm font-semibold">{streak} Day{streak !== 1 ? 's' : ''}</span>
        </div>
      </header>

      {/* View Toggle */}
      <div className="w-full max-w-md px-4 sm:px-6 flex justify-center mb-5">
        <ViewToggle view={viewMode} onChange={setViewMode} />
      </div>

      {/*
       * Sliding container: both views rendered side-by-side, container translates
       * to reveal the active panel. Eliminates AnimatePresence exit/enter timing
       * issues and produces perfectly smooth transitions in both directions.
       */}
      <div className="w-full max-w-md overflow-x-hidden flex-1 overflow-y-auto relative">
        <motion.div
          className="flex items-start"
          style={{ width: '200%', willChange: 'transform' }}
          animate={{ x: viewMode === 'flow' ? '0%' : '-50%' }}
          initial={false}
          transition={{ type: 'spring', stiffness: 360, damping: 36, mass: 0.85 }}
        >
          {/* ── Flow panel ── */}
          <div className="flex flex-col items-center px-4 sm:px-6 pb-4" style={{ width: '50%' }}>
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
                <div className="w-full max-w-sm mt-10 flex items-center justify-between px-2">
                  <div className="flex flex-col">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Up Next</span>
                    <span className="text-sm truncate max-w-[180px] font-medium text-muted-foreground">
                      {pendingTasks.length > 1 ? pendingTasks[1].title : '—'}
                    </span>
                  </div>
                  <button
                    onClick={() => setIsReordering(true)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors bg-muted/60 hover:bg-muted px-3 py-2 rounded-lg font-semibold"
                  >
                    <ArrowUpDown className="w-3.5 h-3.5" />Reorder
                  </button>
                </div>

                {/* Hint */}
                <div className="w-full max-w-sm mt-4 px-2 flex gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><AlarmClock className="w-3 h-3" /><strong>Snooze</strong> — re-queues to end</span>
                  <span className="flex items-center gap-1"><SkipForward className="w-3 h-3" /><strong>Skip</strong> — removes from flow</span>
                </div>
              </>
            ) : (
              <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center justify-center flex-1 w-full max-w-sm text-center px-6 pt-8">
                <div className="w-24 h-24 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-500 rounded-full flex items-center justify-center mb-6">
                  <CheckCircle2 className="w-12 h-12" />
                </div>
                <h2 className="text-2xl font-bold mb-2">All caught up!</h2>
                <p className="text-muted-foreground mb-8">{"You've cleared your task flow. Take a break or add something new."}</p>
                <button onClick={openAddTask} className="w-full py-3.5 bg-secondary text-secondary-foreground font-semibold rounded-xl">Add a new task</button>
              </motion.div>
            )}
          </div>

          {/* ── Calendar panel ── */}
          <div className="flex flex-col items-center px-4 sm:px-6 pb-4" style={{ width: '50%' }}>
            <CalendarView
              tasks={tasks}
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

      {/* FAB */}
      <button
        onClick={openAddTask}
        className="fixed bottom-safe right-6 sm:right-8 w-14 h-14 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-xl shadow-primary/30 hover:bg-primary/90 transition-transform active:scale-90 z-40"
      >
        <Plus className="w-7 h-7" />
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
              className="fixed inset-0 bg-black/50 z-50"
              onClick={() => { setIsAddingTask(false); setIsRepeatMode(false); setForm(DEFAULT_FORM); }}
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
              className="fixed left-[50%] top-[50%] z-50 w-full max-w-[360px] translate-x-[-50%] translate-y-[-50%] bg-card rounded-3xl border border-border shadow-xl flex flex-col"
            >
              {/* Header */}
              <div className="flex items-start justify-between px-6 pt-6 pb-4">
                <div>
                  <h2 id="add-task-title" className="text-lg font-bold">{isRepeatMode ? 'Repeat Task' : 'Add to your Flow'}</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {form.title ? 'Edit the details and pick a new deadline.' : "What's the next thing you need to focus on?"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setIsAddingTask(false); setIsRepeatMode(false); setForm(DEFAULT_FORM); }}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-muted/80 transition-colors flex-shrink-0 ml-3 mt-0.5"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Form body */}
              <form onSubmit={handleAddTask} className="overflow-y-auto px-6 pb-6 space-y-4" style={{ maxHeight: 'calc(75vh - 80px)' }}>
                <div className="space-y-2">
                  <label htmlFor="title" className="text-sm font-medium leading-none">Task Name</label>
                  <input id="title" type="text" autoFocus placeholder="e.g., Draft weekly update"
                    className="flex h-10 w-full rounded-md border border-input bg-input-background px-3 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={form.title} onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))} required />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label htmlFor="minutes" className="text-sm font-medium leading-none">Est. Minutes</label>
                    <input id="minutes" type="number" min="1"
                      className="flex h-10 w-full rounded-md border border-input bg-input-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      value={form.minutes} onChange={(e) => setForm(f => ({ ...f, minutes: e.target.value }))} />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="priority" className="text-sm font-medium leading-none">Priority</label>
                    <select id="priority"
                      className="flex h-10 w-full rounded-md border border-input bg-input-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      value={form.priority} onChange={(e) => setForm(f => ({ ...f, priority: e.target.value as Priority }))}>
                      <option value="P1">High (P1)</option><option value="P2">Medium (P2)</option><option value="P3">Low (P3)</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-2">
                  <label htmlFor="dueDate" className="text-sm font-medium leading-none">Deadline (Optional)</label>
                  <input id="dueDate" type="date"
                    className="flex h-10 w-full appearance-none rounded-md border border-input bg-input-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={form.dueDate} onChange={(e) => setForm(f => ({ ...f, dueDate: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <label htmlFor="tag" className="text-sm font-medium leading-none">Category Tag</label>
                  <select id="tag"
                    className="flex h-10 w-full rounded-md border border-input bg-input-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={form.tag} onChange={(e) => setForm(f => ({ ...f, tag: e.target.value }))}>
                    {PRESET_TAGS.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                  </select>
                </div>
                {/* Actions */}
                <div className="flex flex-col gap-3 pt-1">
                  <button type="submit" className="w-full py-3.5 bg-primary text-primary-foreground rounded-xl font-semibold text-base hover:bg-primary/90 transition-colors active:scale-95">
                    {isRepeatMode ? 'Add Repeated Task' : 'Add Task'}
                  </button>
                  <button type="button" onClick={() => { setIsAddingTask(false); setIsRepeatMode(false); setForm(DEFAULT_FORM); }}
                    className="w-full py-3 bg-muted text-muted-foreground rounded-xl text-sm font-medium hover:bg-muted/80 transition-colors active:scale-95">
                    Cancel
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
