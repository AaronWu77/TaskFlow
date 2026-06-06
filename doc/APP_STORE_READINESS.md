# TaskFlow App Store Readiness

## Submission Scope

TaskFlow is a personal task management app for iOS built with React, Vite, and Capacitor. The App Store submission should present it as a focused personal productivity tool centered on one-task-at-a-time flow.

## Privacy Summary

Current data handled by the app:

| Data | Purpose | Linked to user | Tracking |
|------|---------|----------------|----------|
| Email address | Account registration, login, sync identity | Yes | No |
| Password | Authentication only; hashed on server | Yes | No |
| Tasks, tags, due dates, progress, reminders | Core task management and sync | Yes | No |
| Streak and completion counts | Productivity stats | Yes | No |
| Diagnostic sync state | Troubleshooting sync/auth failures | No advertising use | No |

Do not claim the app collects analytics or tracking data unless an analytics SDK is added later.

## Review Notes

- The app requires an account so tasks can sync across devices.
- Provide Apple Review with a test account before submission.
- The app does not include user-generated public content, social feeds, messaging, or third-party advertising.
- If notification reminders are enabled in a future native build, explain that notifications are local task reminders requested by the user.

## Test Account

Create a dedicated review account in production before submission:

```
Email: app-review@taskflow.example
Password: <set in App Store Connect review notes only>
```

Never commit the real password.

## Screenshot Checklist

Prepare screenshots for required iPhone sizes in both English and Chinese if both locales are marketed:

- Flow view with a focused task card
- Add/edit task form showing deadline, reminder, and repeat controls
- Calendar view with scheduled tasks
- Search/filter state
- Account/language settings
- Empty “all caught up” state

## Pre-Submission Engineering Checklist

- `npm run check` passes from the repository root.
- Backend migrations are deployed.
- No plaintext password is stored in browser/local native storage.
- Login, refresh, logout, and expired-session flows work.
- Offline task creation/edit/completion survives app restart and syncs after reconnect.
- iPhone SE, standard iPhone, and Pro Max layouts have no clipped controls.
- Chinese and English UI have no missing translation keys in core flows.
- App icon and launch screen render correctly.
- Privacy policy URL is live and matches actual data handling.

## Release Notes Template

```
TaskFlow Phase 10 improves account security, sync reliability, task editing, search filters, reminders metadata, repeating tasks, and App Store readiness.
```
