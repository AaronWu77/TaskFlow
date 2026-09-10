import Capacitor
import UIKit

@objc(TaskFlowBridgeViewController)
final class TaskFlowBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TaskFlowSecureStoragePlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
    }
}
