import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('React native bridge keeps the Phase 13 action contract', () => {
  const app = read('src/app/App.tsx');
  assert.match(app, /source:\s*'taskflow\.react'/);
  assert.match(app, /detail\.source\s*!==\s*'taskflow\.native'/);
  assert.match(app, /actionId/);
  assert.match(app, /createTask/);
  assert.match(app, /updateCurrentTask/);
  assert.match(app, /showAddTaskPrompt=\{!isNativeShell\}/);
  assert.match(app, /nativeControls=\{isNativeShell\}/);
  assert.match(app, /repeatDatesAfterStart\(candidate\.dueDate,\s*patch\.repeatUntilDate,\s*candidate\.repeatRule\)/);
  assert.match(app, /progress:\s*_legacyProgress/);
  assert.match(app, /Capacitor\.isNativePlatform\(\)\)\s*\{\s*window\.location\.assign\(PRIVACY_POLICY_URL\)/);
});

test('SwiftUI native shell owns iOS add and details sheets', () => {
  const swift = read('ios/App/App/TaskFlowBridgeViewController.swift');
  assert.match(swift, /private var topNavigation: some View/);
  assert.match(swift, /private var bottomActions: some View/);
  assert.match(swift, /coordinator\.appState == "app" && !coordinator\.isSheetOpen/);
  assert.match(swift, /\.accessibilityHidden\(coordinator\.appState != "app" \|\| coordinator\.isSheetOpen\)/);
  assert.match(swift, /TaskFlowQuickCreateSheet/);
  assert.match(swift, /TaskFlowTaskDetailsSheet/);
  assert.match(swift, /DatePicker\("Due date"/);
  assert.match(swift, /DatePicker\("Reminder time"/);
  assert.match(swift, /DatePicker\("Repeat until"/);
  assert.match(swift, /sendNativeAction\("createTask"/);
  assert.match(swift, /sendNativeAction\("updateCurrentTask"/);
});

test('core task behavior paths remain covered by regression checks', () => {
  const app = read('src/app/App.tsx');
  assert.match(app, /const createTaskFromForm =/);
  assert.match(app, /const repeatedTasks = repeatUntilDate/);
  assert.match(app, /case 'completeCurrent':/);
  assert.match(app, /handleAction\(current\.id, 'complete'\)/);
  assert.match(app, /case 'snoozeCurrent':/);
  assert.match(app, /handleAction\(current\.id, 'snooze'\)/);
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

test('Flow card position and task exit motion stay tuned for Phase 16', () => {
  const app = read('src/app/App.tsx');
  assert.match(app, /isNativeShell \? 'mt-\[clamp\(4\.25rem,9vh,6rem\)\]' : 'mt-\[clamp\(1\.75rem,5vh,3\.25rem\)\]'/);
  assert.match(app, /offset=\{\{ top: isNativeShell \? 'calc\(env\(safe-area-inset-top\) \+ 28px\)' : '10px' \}\}/);
  assert.match(app, /mobileOffset=\{\{[\s\S]*left: '16px'[\s\S]*right: '16px'[\s\S]*\}\}/);
  assert.match(app, /style=\{\{ '--width': '360px' \} as React\.CSSProperties\}/);
  assert.match(app, /minHeight: '42px'/);
  assert.match(app, /borderRadius: '24px'/);
  assert.match(app, /isNativeShell \? 'pb-\[calc\(env\(safe-area-inset-bottom\)\+8\.5rem\)\]' : 'pb-4'/);
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

test('plan tracks the new multi-device sync architecture without legacy compatibility requirements', () => {
  const plan = read('doc/plan.md');
  assert.match(plan, /TaskFlow 多端同步完善计划/);
  assert.match(plan, /不要求前向兼容旧同步协议/);
  assert.match(plan, /TaskChange/);
  assert.match(plan, /pendingOperations/);
  assert.match(plan, /\/sync\/push/);
  assert.doesNotMatch(plan, /Phase 17：/);
});

test('Phase 17 adopts UIScene and gates native controls on authenticated app state', () => {
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
  assert.match(app, /protocolVersion:\s*2/);
  assert.match(app, /appState:\s*'app'/);
  assert.match(swift, /taskFlowBridgeVersion = 2/);
  assert.match(swift, /if appState != "app"/);
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
