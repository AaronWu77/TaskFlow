# TaskFlow TestFlight Release Checklist

## Automated Gate

- Run `npm run check` from the repository root.
- Run `plutil -lint ios/App/App.xcodeproj/project.pbxproj ios/App/App/Info.plist ios/App/App/PrivacyInfo.xcprivacy`.
- Run `xmllint --noout ios/App/App/Base.lproj/Main.storyboard`.
- Build an iOS Release archive on a machine with full Xcode and the current iOS SDK.

## Real Device Regression

- Sign in, register, verify email, refresh session, sign out, and sign back in.
- Create a task from the native quick sheet with due date and reminder.
- Edit the current task from the native details sheet, including priority, estimate, tag, reminder, and repeat-until date.
- Complete the current task and move the current task to later from the native bottom bar.
- Switch Flow and Calendar from the native top bar.
- Confirm Web fallback controls still appear in a normal browser build.
- Test offline launch, offline create/edit/complete, app restart, reconnect, and retry sync.
- Test weak network conflict recovery on two signed-in devices.
- Open privacy policy and support URLs without signing in.
- Delete account from the account page, then confirm old tokens cannot access data.

## App Store Connect

- Privacy Policy URL: `https://taskflow.top/privacy`
- Support URL: `https://taskflow.top/support`
- Review account: create a production account, verify the email, and add sample tasks.
- App Privacy: declare email address, user ID, user content, and product interaction as linked to the user, not used for tracking.
- Screenshots: iPhone Flow, native quick create, Calendar, Account, privacy/support where useful, and empty state in Chinese and English.
- Review notes: account required for cross-device sync, reminders are local notifications selected by the user, no ads or tracking.

## Production Readiness

- `https://taskflow.top/api/health` returns healthy status.
- Production CORS includes `https://taskflow.top`, `https://www.taskflow.top`, and `capacitor://localhost`.
- `COOKIE_SECURE=true` in production.
- Resend domain and sender are verified.
- Database migrations are applied and backup/restore procedure is known.
- Certificate renewal date and DNS challenge procedure are recorded in deployment notes.
