import Capacitor
import SwiftUI
import WebKit

private let taskFlowBridgeVersion = 2

struct TaskFlowNativeTask: Equatable {
    let id: String
    let title: String
    let priority: String
    let dueDate: String?
    let estimateMinutes: Int?
    let tag: String?
    let reminderAt: String?
    let repeatRule: String
    let repeatUntilDate: String?
}

final class TaskFlowNativeBridgeCoordinator: NSObject, ObservableObject, WKScriptMessageHandler {
    @Published var appState = "loading"
    @Published var currentView = "flow"
    @Published var currentTask: TaskFlowNativeTask?
    @Published var pendingCount = 0
    @Published var canComplete = false
    @Published var isSyncing = false
    @Published var isSheetOpen = false
    @Published var keyboardOffset: CGFloat = 0

    weak var bridgeController: CAPBridgeViewController?

    override init() {
        super.init()
        observeKeyboard()
    }

    deinit {
        bridgeController?.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "taskflowNative")
        NotificationCenter.default.removeObserver(self)
    }

    func attachBridgeController(_ controller: CAPBridgeViewController) {
        bridgeController = controller
        _ = controller.view
        controller.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "taskflowNative")
        controller.webView?.configuration.userContentController.add(self, name: "taskflowNative")
        postNativeReady()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "taskflowNative",
              let envelope = message.body as? [String: Any],
              envelope["source"] as? String == "taskflow.react",
              envelope["type"] as? String == "uiState",
              bridgeVersion(from: envelope["protocolVersion"]) == taskFlowBridgeVersion,
              let payload = envelope["payload"] as? [String: Any] else {
            return
        }
        applyReactState(payload)
    }

    func sendNativeAction(_ action: String, payload: [String: Any] = [:]) {
        let allowedActions: Set<String> = [
            "setView",
            "openAccount",
            "addTask",
            "createTask",
            "updateCurrentTask",
            "completeCurrent",
            "snoozeCurrent",
            "openDate",
            "openReminder",
            "openRepeat"
        ]
        guard allowedActions.contains(action) else { return }

        let envelope: [String: Any] = [
            "source": "taskflow.native",
            "protocolVersion": taskFlowBridgeVersion,
            "action": action,
            "actionId": UUID().uuidString,
            "payload": payload
        ]
        dispatchEvent(named: "taskflow:native-action", detail: envelope)
    }

    private func observeKeyboard() {
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardFrameChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardFrameChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    @objc private func keyboardFrameChanged(_ notification: Notification) {
        guard let hostView = bridgeController?.view,
              let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else {
            keyboardOffset = 0
            return
        }
        let converted = hostView.convert(frame, from: nil)
        keyboardOffset = max(0, hostView.bounds.maxY - converted.minY - hostView.safeAreaInsets.bottom + 10)
    }

    private func applyReactState(_ payload: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            appState = payload["appState"] as? String ?? "loading"
            if appState != "app" {
                currentView = "flow"
                currentTask = nil
                pendingCount = 0
                canComplete = false
                isSyncing = false
                isSheetOpen = false
                return
            }
            currentView = payload["currentView"] as? String ?? "flow"
            pendingCount = intValue(from: payload["pendingCount"]) ?? 0
            canComplete = boolValue(from: payload["canComplete"]) ?? false
            isSyncing = boolValue(from: payload["isSyncing"]) ?? false
            isSheetOpen = boolValue(from: payload["isSheetOpen"]) ?? false

            if let task = payload["currentTask"] as? [String: Any] {
                let title = task["title"] as? String
                currentTask = TaskFlowNativeTask(
                    id: task["id"] as? String ?? "",
                    title: title?.isEmpty == false ? title! : "Untitled",
                    priority: task["priority"] as? String ?? "P2",
                    dueDate: task["dueDate"] as? String,
                    estimateMinutes: intValue(from: task["estimateMinutes"]),
                    tag: task["tag"] as? String,
                    reminderAt: task["reminderAt"] as? String,
                    repeatRule: task["repeatRule"] as? String ?? "none",
                    repeatUntilDate: task["repeatUntilDate"] as? String
                )
            } else {
                currentTask = nil
            }
        }
    }

    private func postNativeReady() {
        let detail: [String: Any] = [
            "source": "taskflow.native",
            "protocolVersion": taskFlowBridgeVersion
        ]
        dispatchEvent(named: "taskflow:native-ready", detail: detail)
    }

    private func dispatchEvent(named name: String, detail: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        let script = "window.dispatchEvent(new CustomEvent('\(name)', { detail: \(json) }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridgeController?.webView?.evaluateJavaScript(script)
        }
    }

    private func bridgeVersion(from value: Any?) -> Int? {
        if let intValue = value as? Int { return intValue }
        if let numberValue = value as? NSNumber { return numberValue.intValue }
        return nil
    }

    private func intValue(from value: Any?) -> Int? {
        if let intValue = value as? Int { return intValue }
        if let numberValue = value as? NSNumber { return numberValue.intValue }
        return nil
    }

    private func boolValue(from value: Any?) -> Bool? {
        if let boolValue = value as? Bool { return boolValue }
        if let numberValue = value as? NSNumber { return numberValue.boolValue }
        return nil
    }
}

struct TaskFlowCapacitorContainer: UIViewControllerRepresentable {
    @ObservedObject var coordinator: TaskFlowNativeBridgeCoordinator

    func makeUIViewController(context: Context) -> CAPBridgeViewController {
        let controller = CAPBridgeViewController()
        coordinator.attachBridgeController(controller)
        return controller
    }

    func updateUIViewController(_ uiViewController: CAPBridgeViewController, context: Context) {
        if coordinator.bridgeController !== uiViewController {
            coordinator.attachBridgeController(uiViewController)
        }
    }

    static func dismantleUIViewController(_ uiViewController: CAPBridgeViewController, coordinator: ()) {
        uiViewController.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "taskflowNative")
    }
}

struct TaskFlowNativeShell: View {
    @ObservedObject var coordinator: TaskFlowNativeBridgeCoordinator

    var body: some View {
        ZStack(alignment: .bottom) {
            TaskFlowCapacitorContainer(coordinator: coordinator)
                .ignoresSafeArea()

            TaskFlowNativeOverlay(coordinator: coordinator)
        }
    }
}

struct TaskFlowNativeOverlay: View {
    @ObservedObject var coordinator: TaskFlowNativeBridgeCoordinator
    @State private var activeSheet: TaskFlowNativeSheet?
    @State private var quickDraft = TaskFlowQuickDraft()
    @State private var detailDraft = TaskFlowTaskDraft()

    var body: some View {
        VStack(spacing: 0) {
            topNavigation
                .padding(.horizontal, 12)
                .padding(.top, 8)

            Spacer(minLength: 0)

            bottomActions
                .padding(.horizontal, 12)
                .padding(.bottom, max(10, coordinator.keyboardOffset))
        }
        .opacity(coordinator.appState == "app" && !coordinator.isSheetOpen ? 1 : 0)
        .allowsHitTesting(coordinator.appState == "app" && !coordinator.isSheetOpen)
        .accessibilityHidden(coordinator.appState != "app" || coordinator.isSheetOpen)
        .animation(.easeOut(duration: 0.16), value: coordinator.isSheetOpen)
        .animation(.easeOut(duration: 0.16), value: coordinator.appState)
        .onChange(of: coordinator.appState) { _, state in
            if state != "app" {
                activeSheet = nil
            }
        }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .quickCreate:
                TaskFlowQuickCreateSheet(draft: $quickDraft) {
                    coordinator.sendNativeAction("createTask", payload: quickDraft.payload)
                    activeSheet = nil
                } onCancel: {
                    activeSheet = nil
                }
                .presentationDetents([.medium])
            case .taskDetails:
                TaskFlowTaskDetailsSheet(draft: $detailDraft) {
                    coordinator.sendNativeAction("updateCurrentTask", payload: detailDraft.payload)
                    activeSheet = nil
                }
                .presentationDetents([.large])
            }
        }
    }

    private var topNavigation: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text("TaskFlow")
                    .font(.caption.weight(.bold))
                Text(coordinator.isSyncing ? "Syncing" : "\(coordinator.pendingCount) pending")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Button(action: { coordinator.sendNativeAction("setView", payload: ["view": "flow"]) }) {
                Text("Flow")
            }
            .accessibilityLabel("Flow view")
            .buttonStyle(TaskFlowNativePillButtonStyle(isSelected: coordinator.currentView == "flow"))

            Button(action: { coordinator.sendNativeAction("setView", payload: ["view": "calendar"]) }) {
                Text("Calendar")
            }
            .accessibilityLabel("Calendar view")
            .buttonStyle(TaskFlowNativePillButtonStyle(isSelected: coordinator.currentView == "calendar"))

            Button(action: { coordinator.sendNativeAction("openAccount") }) {
                Image(systemName: "person.crop.circle")
            }
            .accessibilityLabel("Account")
            .buttonStyle(TaskFlowNativeIconButtonStyle())
        }
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var bottomActions: some View {
        HStack(spacing: 8) {
            Button(action: openCurrentDetails) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(coordinator.currentTask?.title ?? "No task")
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                    Text("\(coordinator.pendingCount) pending\(coordinator.isSyncing ? " syncing" : "")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .disabled(coordinator.currentTask == nil)

            Button(action: openQuickCreate) {
                Image(systemName: "plus")
            }
            .accessibilityLabel("Add task")
            .buttonStyle(TaskFlowNativeIconButtonStyle())

            Button(action: { coordinator.sendNativeAction("snoozeCurrent") }) {
                Image(systemName: "text.line.last.and.arrowtriangle.forward")
            }
            .accessibilityLabel("Move current task to later")
            .buttonStyle(TaskFlowNativeIconButtonStyle())
            .disabled(!coordinator.canComplete)

            Button(action: { coordinator.sendNativeAction("completeCurrent") }) {
                Image(systemName: "checkmark")
            }
            .accessibilityLabel("Complete current task")
            .buttonStyle(TaskFlowNativePrimaryButtonStyle())
            .disabled(!coordinator.canComplete)
        }
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func openQuickCreate() {
        quickDraft = TaskFlowQuickDraft()
        activeSheet = .quickCreate
    }

    private func openCurrentDetails() {
        guard let task = coordinator.currentTask else { return }
        detailDraft = TaskFlowTaskDraft(task: task)
        activeSheet = .taskDetails
    }
}

private enum TaskFlowNativeSheet: String, Identifiable {
    case quickCreate
    case taskDetails

    var id: String { rawValue }
}

private struct TaskFlowQuickDraft {
    var title = ""
    var priority = "P2"
    var dueDate = Date()
    var reminderEnabled = false
    var reminderAt = Calendar.current.date(byAdding: .hour, value: 1, to: Date()) ?? Date()

    var payload: [String: Any] {
        var value: [String: Any] = [
            "title": title,
            "priority": priority,
            "dueDate": Self.dateFormatter.string(from: dueDate),
            "repeatRule": "none"
        ]
        if reminderEnabled {
            value["reminderAt"] = reminderAt.ISO8601Format()
        }
        return value
    }

    static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

private struct TaskFlowTaskDraft {
    var title = ""
    var priority = "P2"
    var dueDate = Date()
    var estimateMinutes = 0
    var tag = ""
    var reminderEnabled = false
    var reminderAt = Calendar.current.date(byAdding: .hour, value: 1, to: Date()) ?? Date()
    var repeatRule = "none"
    var repeatUntilDate = Calendar.current.date(byAdding: .day, value: 7, to: Date()) ?? Date()

    init() {}

    init(task: TaskFlowNativeTask) {
        title = task.title
        priority = task.priority
        dueDate = Self.date(from: task.dueDate) ?? Date()
        estimateMinutes = task.estimateMinutes ?? 0
        tag = task.tag ?? ""
        repeatRule = task.repeatRule
        repeatUntilDate = Self.date(from: task.repeatUntilDate) ?? Calendar.current.date(byAdding: .day, value: 7, to: dueDate) ?? dueDate
        if let reminder = task.reminderAt, let parsed = ISO8601DateFormatter().date(from: reminder) {
            reminderEnabled = true
            reminderAt = parsed
        }
    }

    var payload: [String: Any] {
        var value: [String: Any] = [
            "title": title,
            "priority": priority,
            "dueDate": Self.dateFormatter.string(from: dueDate),
            "estimateMinutes": estimateMinutes > 0 ? estimateMinutes : NSNull(),
            "tag": tag.isEmpty ? NSNull() : tag,
            "reminderAt": reminderEnabled ? reminderAt.ISO8601Format() : NSNull(),
            "repeatRule": repeatRule,
            "repeatUntilDate": repeatRule == "none" ? NSNull() : Self.dateFormatter.string(from: repeatUntilDate)
        ]
        return value
    }

    static func date(from value: String?) -> Date? {
        guard let value = value else { return nil }
        return dateFormatter.date(from: value)
    }

    static let dateFormatter = TaskFlowQuickDraft.dateFormatter
}

private struct TaskFlowQuickCreateSheet: View {
    @Binding var draft: TaskFlowQuickDraft
    let onSubmit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Task title", text: $draft.title)
                    Picker("Priority", selection: $draft.priority) {
                        Text("P1").tag("P1")
                        Text("P2").tag("P2")
                        Text("P3").tag("P3")
                    }
                    DatePicker("Due date", selection: $draft.dueDate, displayedComponents: .date)
                    Toggle("Reminder", isOn: $draft.reminderEnabled)
                    if draft.reminderEnabled {
                        DatePicker("Reminder time", selection: $draft.reminderAt)
                    }
                }
            }
            .navigationTitle("New Task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add", action: onSubmit)
                        .disabled(draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

private struct TaskFlowTaskDetailsSheet: View {
    @Binding var draft: TaskFlowTaskDraft
    let onSubmit: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Task title", text: $draft.title)
                    Picker("Priority", selection: $draft.priority) {
                        Text("P1").tag("P1")
                        Text("P2").tag("P2")
                        Text("P3").tag("P3")
                    }
                    DatePicker("Due date", selection: $draft.dueDate, displayedComponents: .date)
                    Stepper(value: $draft.estimateMinutes, in: 0...1440, step: 5) {
                        Text(draft.estimateMinutes > 0 ? "\(draft.estimateMinutes) minutes" : "No estimate")
                    }
                    TextField("Tag", text: $draft.tag)
                }

                Section("Reminder") {
                    Toggle("Reminder", isOn: $draft.reminderEnabled)
                    if draft.reminderEnabled {
                        DatePicker("Reminder time", selection: $draft.reminderAt)
                    }
                }

                Section("Repeat") {
                    Picker("Repeat", selection: $draft.repeatRule) {
                        Text("None").tag("none")
                        Text("Daily").tag("daily")
                        Text("Weekly").tag("weekly")
                        Text("Monthly").tag("monthly")
                    }
                    if draft.repeatRule != "none" {
                        DatePicker("Repeat until", selection: $draft.repeatUntilDate, displayedComponents: .date)
                    }
                }
            }
            .navigationTitle("Task Details")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: onSubmit)
                        .disabled(draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

private struct TaskFlowNativePillButtonStyle: ButtonStyle {
    let isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(isSelected ? Color.primary.opacity(0.14) : Color.secondary.opacity(0.08), in: Capsule())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

private struct TaskFlowNativeIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.bold))
            .frame(width: 36, height: 36)
            .background(Color.secondary.opacity(0.10), in: Circle())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

private struct TaskFlowNativePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.bold))
            .frame(width: 38, height: 38)
            .background(Color.primary.opacity(0.88), in: Circle())
            .foregroundStyle(Color(uiColor: .systemBackground))
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

@objc(TaskFlowBridgeViewController)
final class TaskFlowBridgeViewController: UIHostingController<TaskFlowNativeShell> {
    private let bridgeCoordinator: TaskFlowNativeBridgeCoordinator

    required init?(coder aDecoder: NSCoder) {
        let coordinator = TaskFlowNativeBridgeCoordinator()
        bridgeCoordinator = coordinator
        super.init(coder: aDecoder, rootView: TaskFlowNativeShell(coordinator: coordinator))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
    }
}
