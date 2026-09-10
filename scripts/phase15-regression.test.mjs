import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('React controls are the only task interaction surface', () => {
  const app = read('src/app/App.tsx');
  assert.doesNotMatch(app, /taskflowNative/);
  assert.doesNotMatch(app, /taskflow:native/);
  assert.doesNotMatch(app, /NativeBridge/);
  assert.doesNotMatch(app, /postNativeState/);
  assert.doesNotMatch(app, /useNativeChrome/);
  assert.match(app, /<header className="w-full max-w-md/);
  assert.match(app, /<ViewToggle view=\{viewMode\} onChange=\{setViewMode\}/);
  assert.match(app, /onClick=\{\(\) => setAccountOpen\(true\)\}/);
  assert.match(app, /onClick=\{openAddTask\}/);
  assert.match(app, /showAddTaskPrompt\s*\n\s*nativeControls=\{false\}/);
  assert.match(app, /<QuickCreateDialog[\s\S]*open=\{isAddingTask\}/);
  assert.match(app, /<TaskDetailsSheet[\s\S]*open=\{isTaskDetailsOpen\}/);
  assert.match(app, /<TaskDetailModal[\s\S]*task=\{flowDetailTask\}/);
  assert.match(app, /onOpen=\{isTop \? \(\) => setFlowDetailTaskId\(task\.id\) : undefined\}/);
  assert.match(app, /onClick=\{\(\) => setIsReordering\(true\)\}/);
  assert.match(app, /function CalendarView[\s\S]{0,900}\)\s*\{\s*const \{ t, i18n \} = useTranslation\(\)/);
  assert.match(app, /toLocaleDateString\(i18n\.language === 'zh'/);
  assert.match(app, /onClick=\{\(\) => !nativeControls && setDetailTaskId\(task\.id\)\}/);
  assert.match(app, /onClick=\{\(\) => !nativeControls && setRepeatTask\(task\)\}/);
  assert.match(app, /progress:\s*_legacyProgress/);
  assert.doesNotMatch(app, /PRIVACY_POLICY_URL/);
  assert.doesNotMatch(app, /openPublicPrivacyPolicy/);
  assert.match(app, /onOpenPrivacy=\{\(\) => setPrivacyOpen\(true\)\}/);
  assert.match(app, /<PrivacyPolicyDialog[\s\S]*open=\{privacyOpen\}/);
  assert.doesNotMatch(app, /account\.signOutBlockedPending/);
  assert.doesNotMatch(app, /account\.deleteAccountBlocked/);
  assert.match(app, /const effectiveSyncStatus = useMemo/);
  assert.match(app, /visibleSyncStatus\(syncStatus, pendingOperations, syncMeta, cloudSyncEnabled\)/);
  assert.match(app, /if \(rawStatus === 'error'\) return 'error'/);
  assert.match(app, /if \(pending\.length > 0 && readyPending\.length === 0\)/);
  assert.match(app, /const syncRequiresUserAction = effectiveSyncStatus === 'conflict'/);
  assert.match(app, /const shouldNotify = effectiveSyncStatus === 'error' \|\| effectiveSyncStatus === 'offline' \|\| effectiveSyncStatus === 'conflict'/);
  assert.match(app, /toast\(t\(`sync\.\$\{effectiveSyncStatus\}`\)/);
  assert.match(app, /duration: effectiveSyncStatus === 'conflict' \? 6000 : 3500/);
  assert.match(app, /TaskFlow sync failed/);
  assert.match(app, /syncStatus=\{effectiveSyncStatus\}/);
  assert.match(app, /account\.syncNotComplete/);
  assert.match(app, /const retryAllSyncOperations = React\.useCallback/);
  assert.match(app, /operation\.status === 'failed'[\s\S]*status: 'pending' as const/);
  assert.match(app, /onRetrySync=\{retryAllSyncOperations\}/);
});

test('iOS shell is a thin Capacitor container without SwiftUI native controls', () => {
  const swift = read('ios/App/App/TaskFlowBridgeViewController.swift');
  assert.match(swift, /final class TaskFlowBridgeViewController: CAPBridgeViewController/);
  assert.doesNotMatch(swift, /SwiftUI/);
  assert.doesNotMatch(swift, /UIHostingController/);
  assert.doesNotMatch(swift, /TaskFlowNative/);
  assert.doesNotMatch(swift, /sendNativeAction/);
  assert.doesNotMatch(swift, /Button\(/);
});

test('core task behavior paths remain covered by regression checks', () => {
  const app = read('src/app/App.tsx');
  assert.match(app, /const createTaskFromForm =/);
  assert.match(app, /const repeatedTasks = repeatUntilDate/);
  assert.match(app, /function TaskCard/);
  assert.match(app, /const handleAction =/);
  assert.match(app, /onAction\(task\.id, action\)/);
  assert.match(app, /if \(!cloudSyncEnabled\)/);
  assert.match(app, /isOperationReady/);
  assert.match(app, /remapOperationIds/);
  assert.match(app, /removeTaskFromOperation/);
  assert.match(app, /ConflictResolutionPage/);
  assert.match(app, /conflictFieldsFor/);
  assert.match(app, /type:\s*'resolve-conflict'/);
  assert.match(app, /syncConflict\.open/);
  assert.match(app, /apiPushOperations\(getDeviceId\(user\.id\), readyPending\)/);
  assert.match(app, /apiPullChanges\(cursor\)/);
  assert.match(app, /status === 'conflict'/);
  assert.match(app, /normalizeCachedTask/);
});

test('task creation reads committed form controls on submit', () => {
  const app = read('src/app/App.tsx');
  assert.match(app, /const taskFormFromSubmit = \(formElement: HTMLFormElement, base: AddTaskState\): AddTaskState =>/);
  for (const name of ['title', 'dueDate', 'priority', 'minutes', 'tag', 'reminderAt', 'repeatRule', 'repeatUntilDate']) {
    assert.match(app, new RegExp(`name="${name}"`));
  }
  assert.match(app, /const quickForm = taskFormFromSubmit\(event\.currentTarget/);
  assert.match(app, /const submittedForm = taskFormFromSubmit\(e\.currentTarget, form\)/);
  assert.match(app, /validateTaskForm\(submittedForm\)/);
  assert.match(app, /createTaskFromForm\(submittedForm\)/);
  assert.match(app, /repeatInstanceCount\(submittedForm\.dueDate, submittedForm\.repeatUntilDate, submittedForm\.repeatRule\)/);
});

test('accent theme presets stay visually distinct', () => {
  const app = read('src/app/App.tsx');
  assert.match(app, /type AccentTheme = 'tcx111400' \| 'tcx134306' \| 'tcx133802' \| 'tcx136006' \| 'tcx140837'/);
  assert.match(app, /tcx140837: \{\s*primary: '#E5D39A'/);
  assert.doesNotMatch(app, /tcx121107/);
  const zh = read('src/i18n/locales/zh.json');
  const en = read('src/i18n/locales/en.json');
  assert.match(zh, /"tcx140837": "14-0837 TCX"/);
  assert.match(en, /"tcx140837": "14-0837 TCX"/);
});

test('legacy reorder sheet keeps the six-dot drag handle and move controls', () => {
  const app = read('src/app/App.tsx');
  assert.match(app, /function ReorderSheet/);
  assert.match(app, /GripVertical/);
  assert.match(app, /ArrowUpDown/);
  assert.match(app, /onHandlePointerDown/);
  assert.match(app, /onMoveUp/);
  assert.match(app, /onMoveDown/);
  assert.match(app, /setIsReordering/);
  assert.match(app, /type: 'reorder'/);
});

test('npm run ios rebuilds, syncs, and opens the iOS project for device testing', () => {
  const packageJson = read('package.json');
  assert.match(packageJson, /"ios": "npm run build && npx cap sync ios && xattr -cr ios\/App\/App && npx cap open ios"/);
  assert.match(packageJson, /xattr -cr ios\/App\/App/);
  assert.match(packageJson, /npx cap open ios/);
  assert.doesNotMatch(packageJson, /xcodebuild|simctl/);
});

test('Flow card position and task exit motion stay tuned for Phase 16', () => {
  const app = read('src/app/App.tsx');
  assert.match(app, /'mt-\[clamp\(1\.75rem,5vh,3\.25rem\)\]'/);
  assert.match(app, /offset=\{\{ top: isNativeShell \? 'calc\(env\(safe-area-inset-top\) \+ 28px\)' : '10px' \}\}/);
  assert.match(app, /mobileOffset=\{\{[\s\S]*left: '16px'[\s\S]*right: '16px'[\s\S]*\}\}/);
  assert.match(app, /style=\{\{ '--width': '360px' \} as React\.CSSProperties\}/);
  assert.match(app, /minHeight: '42px'/);
  assert.match(app, /borderRadius: '24px'/);
  assert.match(app, /className="h-full overflow-y-auto px-4 sm:px-6 pb-4"/);
  assert.match(app, /if \(action === 'complete'\)[\s\S]*y: -82[\s\S]*scale: 0\.94/);
  assert.match(app, /if \(action === 'skip'\)[\s\S]*x: -132[\s\S]*rotate: -4/);
  assert.match(app, /if \(action === 'snooze'\)[\s\S]*y: 112[\s\S]*x: 72/);
  assert.match(app, /stiffness: 340, damping: 34, mass: 0\.72/);
});

test('iOS release scope remains iPhone portrait on iOS 17 with privacy manifest', () => {
  const project = read('ios/App/App.xcodeproj/project.pbxproj');
  const info = read('ios/App/App/Info.plist');
  const privacy = read('ios/App/App/PrivacyInfo.xcprivacy');
  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET = 17\.0;/);
  assert.match(project, /TARGETED_DEVICE_FAMILY = 1;/);
  assert.match(project, /MARKETING_VERSION = 1\.0\.1;/);
  assert.match(project, /CURRENT_PROJECT_VERSION = 1\.0\.1;/);
  assert.match(project, /PrivacyInfo\.xcprivacy in Resources/);
  assert.match(info, /UIInterfaceOrientationPortrait/);
  assert.doesNotMatch(info, /UIInterfaceOrientationLandscape/);
  assert.match(privacy, /NSPrivacyTracking<\/key>\s*<false\/>/);
  assert.match(privacy, /NSPrivacyCollectedDataTypeEmailAddress/);
  assert.match(privacy, /NSPrivacyCollectedDataTypeOtherUserContent/);
});

test('public privacy and support pages contain App Store required disclosures', () => {
  assert.equal(existsSync(new URL('../public/privacy/index.html', import.meta.url)), true);
  assert.equal(existsSync(new URL('../public/support/index.html', import.meta.url)), true);
  const privacy = read('public/privacy/index.html');
  const support = read('public/support/index.html');
  for (const term of ['Resend', '账号删除', 'support@taskflow.top', 'App Store Connect', '是否追踪', 'Other User Content']) {
    assert.match(privacy, new RegExp(term));
  }
  assert.match(support, /support@taskflow\.top/);
  assert.match(support, /删除账号/);
  assert.match(support, /Account deletion/);
});

test('developer manual records the current multi-device sync architecture', () => {
  const manual = read('doc/DEVELOPER.md');
  assert.match(manual, /TaskFlow 开发者手册/);
  assert.match(manual, /不要恢复旧的全局缓存或旧同步协议/);
  assert.match(manual, /TaskChange/);
  assert.match(manual, /pendingOperations/);
  assert.match(manual, /POST \/sync\/push/);
  assert.match(manual, /冲突处理页/);
});

test('iOS uses UIScene while React remains the only control surface', () => {
  const info = read('ios/App/App/Info.plist');
  const project = read('ios/App/App.xcodeproj/project.pbxproj');
  const scene = read('ios/App/App/SceneDelegate.swift');
  const app = read('src/app/App.tsx');
  const swift = read('ios/App/App/TaskFlowBridgeViewController.swift');
  assert.match(info, /UIApplicationSceneManifest/);
  assert.match(info, /UISceneDelegateClassName/);
  assert.match(info, /UISceneStoryboardFile/);
  assert.doesNotMatch(info, /UIMainStoryboardFile/);
  assert.match(project, /SceneDelegate\.swift in Sources/);
  assert.match(scene, /UIWindowSceneDelegate/);
  assert.match(scene, /ApplicationDelegateProxy\.shared\.application/);
  assert.doesNotMatch(app, /protocolVersion:\s*2/);
  assert.doesNotMatch(app, /taskflowNative/);
  assert.match(swift, /final class TaskFlowBridgeViewController: CAPBridgeViewController/);
  assert.doesNotMatch(swift, /taskFlowBridgeVersion/);
  assert.doesNotMatch(swift, /appState != "app"/);
  assert.doesNotMatch(swift, /WKScriptMessageHandler/);
});

test('new sync engine uses cursor-based push-pull instead of legacy dirty flush', () => {
  const app = read('src/app/App.tsx');
  const api = read('src/app/api.ts');
  const backend = read('backend/src/routes/sync.ts');
  const schema = read('backend/src/prisma/schema.prisma');
  assert.match(app, /syncInFlightRef\.current/);
  assert.match(app, /syncRequestedRef\.current/);
  assert.match(app, /pendingOperationsRef\.current/);
  assert.match(app, /apiPushOperations/);
  assert.match(app, /apiPullChanges/);
  assert.match(app, /syncCursor/);
  assert.doesNotMatch(app, /flushDirtyTasks/);
  assert.doesNotMatch(app, /apiReorderTasks/);
  assert.doesNotMatch(app, /apiCreateTask/);
  assert.doesNotMatch(app, /apiUpdateTask/);
  assert.match(api, /createSingleFlight\(performRefresh\)/);
  assert.match(api, /apiSyncBootstrap/);
  assert.match(api, /apiPushOperations/);
  assert.match(backend, /router\.post\('\/push'/);
  assert.match(backend, /recordChange/);
  assert.match(schema, /model TaskChange/);
  assert.match(schema, /model UserSyncState/);
});

test('sync mutations have one versioned write path with user-scoped idempotency', () => {
  const tasksRoute = read('backend/src/routes/tasks.ts');
  const syncRoute = read('backend/src/routes/sync.ts');
  const schema = read('backend/src/prisma/schema.prisma');
  const migration = read('backend/src/prisma/migrations/20260908010000_scope_operation_ids/migration.sql');
  assert.doesNotMatch(tasksRoute, /router\.(post|put|patch|delete)\(/);
  assert.match(tasksRoute, /SYNC_PROTOCOL_REQUIRED/);
  assert.match(syncRoute, /taskOperation\.findUnique/);
  assert.match(syncRoute, /CURSOR_EXPIRED/);
  assert.match(schema, /@@unique\(\[userId, operationId\]\)/);
  assert.match(migration, /Preserve idempotency/);
});

test('refresh tokens remain out of web storage and native tokens use secure storage', () => {
  const app = read('src/app/App.tsx');
  const api = read('src/app/api.ts');
  const secureStorage = read('src/app/secure-storage.ts');
  const swift = read('ios/App/App/TaskFlowSecureStoragePlugin.swift');
  assert.doesNotMatch(app, /restoreNativeStorageWithTimeout\(\[[^\]]*taskflow_refresh_token/);
  assert.doesNotMatch(api, /localStorage\.setItem\(REFRESH_TOKEN_KEY/);
  assert.match(secureStorage, /TaskFlowSecureStorage/);
  assert.match(swift, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
});
