import ExpoModulesCore
import Foundation
import WidgetKit

public class MusubiAgendaWidgetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MusubiAgendaWidget")
    AsyncFunction("beginSession") { (scope: String) -> Int64 in
      let lifecycle = try WidgetStore.shared().begin(scope)
      WidgetCenter.shared.reloadAllTimelines()
      return lifecycle
    }
    AsyncFunction("updateSnapshot") { (raw: String) -> Bool in
      let accepted = try WidgetStore.shared().write(Data(raw.utf8))
      if accepted { WidgetCenter.shared.reloadAllTimelines() }
      return accepted
    }
    AsyncFunction("clearSnapshot") {
      try WidgetStore.shared().clear()
      WidgetCenter.shared.reloadAllTimelines()
    }
    AsyncFunction("consumeTaskCompletion") { (token: String, scope: String) -> [String: Any]? in
      guard let ticket = try WidgetStore.shared().consume(token, scope: scope, now: Date().timeIntervalSince1970 * 1000) else { return nil }
      return ["taskId": ticket.taskId, "revision": ticket.revision, "scope": ticket.scope,
        "providerReadRetiredGeneration": ticket.providerReadRetiredGeneration]
    }
  }
}
