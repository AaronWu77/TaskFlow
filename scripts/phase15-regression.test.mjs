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
  assert.match(swift, /\.opacity\(coordinator\.isSheetOpen \? 0 : 1\)/);
  assert.match(swift, /\.allowsHitTesting\(!coordinator\.isSheetOpen\)/);
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
  assert.match(app, /isTaskConflictError\(error\)/);
  assert.match(app, /TASK_CONFLICT|sync\.conflict|_conflict/);
  assert.match(app, /normalizeCachedTask/);
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

test('plan is closed after Phase 15 and no longer lists stale phase work', () => {
  const plan = read('doc/plan.md');
  assert.match(plan, /T6：.*\[x\]|- \[x\] T6/);
  assert.match(plan, /T7：.*\[x\]|- \[x\] T7/);
  assert.match(plan, /T8：.*\[x\]|- \[x\] T8/);
  assert.doesNotMatch(plan, /### Phase 13/);
  assert.doesNotMatch(plan, /### Phase 14/);
  assert.doesNotMatch(plan, /### Phase 15/);
});
