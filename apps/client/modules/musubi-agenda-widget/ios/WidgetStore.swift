import Foundation

enum WidgetStoreError: Error { case unavailableContainer, invalidSnapshot, unreadableState }
struct WidgetTaskTicket: Codable {
  var taskId: String; var revision: Int64; var scope: String
  var providerReadRetiredGeneration: Int64; var issued: Double
  func live(scope: String, now: Double) -> Bool {
    self.scope == scope && revision > 0 && now >= issued && now - issued < 86_400_000
  }
}
struct WidgetStoreState: Codable {
  var scope: String? = nil; var lifecycle: Int64 = 0; var generation: Int64 = 0
  var snapshot: WidgetSnapshot? = nil; var tickets: [String: WidgetTaskTicket] = [:]
}

/// The extension shares display data and one-use action requests, never auth.
/// Coordination and an atomic replacement serialize writers across processes.
final class WidgetStore {
  let url: URL
  init(url: URL) { self.url = url }
  static func shared() throws -> WidgetStore {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "MusubiWidgetAppGroup") as? String,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw WidgetStoreError.unavailableContainer }
    return WidgetStore(url: container.appendingPathComponent("widgets-v2.json"))
  }
  private func load(_ path: URL) throws -> WidgetStoreState {
    guard FileManager.default.fileExists(atPath: path.path) else { return WidgetStoreState() }
    let data = try Data(contentsOf: path)
    guard data.count <= WidgetSnapshot.byteLimit + 262_144 else { throw WidgetStoreError.unreadableState }
    let state = try JSONDecoder().decode(WidgetStoreState.self, from: data)
    if let snapshot = state.snapshot {
      _ = try WidgetSnapshot.decode(JSONEncoder().encode(snapshot))
      guard snapshot.scope == state.scope else { throw WidgetStoreError.unreadableState }
    }
    return state
  }
  func read() throws -> WidgetStoreState {
    var result: Result<WidgetStoreState, Error>?
    var error: NSError?
    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &error) { path in
      result = Result { try self.load(path) }
    }
    if let error { throw error }
    guard let result else { throw WidgetStoreError.unreadableState }
    return try result.get()
  }
  @discardableResult private func change<T>(recover: Bool = false, _ action: (inout WidgetStoreState) throws -> T) throws -> T {
    var result: Result<T, Error>?
    var error: NSError?
    NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &error) { path in
      result = Result {
        var state: WidgetStoreState
        do { state = try self.load(path) }
        catch {
          guard recover else { throw error }
          // A broken display cache must not prevent the sign-out barrier.
          // A high new fence also rejects writes from an older JS session.
          state = WidgetStoreState(lifecycle: Int64(Date().timeIntervalSince1970 * 1000))
        }
        let value = try action(&state)
        let data = try JSONEncoder().encode(state)
        try data.write(to: path, options: .atomic)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path.path)
        #endif
        return value
      }
    }
    if let error { throw error }
    guard let result else { throw WidgetStoreError.unreadableState }
    return try result.get()
  }
  func begin(_ scope: String) throws -> Int64 {
    guard !scope.isEmpty else { throw WidgetStoreError.invalidSnapshot }
    return try change(recover: true) { state in
      if state.scope != scope { state.snapshot = nil; state.tickets = [:] }
      state.scope = scope; state.lifecycle += 1; state.generation = 0
      return state.lifecycle
    }
  }
  func clear() throws {
    try change(recover: true) { state in
      state.scope = nil; state.lifecycle += 1; state.generation = 0
      state.snapshot = nil; state.tickets = [:]
    }
  }
  func write(_ data: Data) throws -> Bool {
    let incoming = try WidgetSnapshot.decode(data)
    return try change { state in
      guard incoming.scope == state.scope, incoming.lifecycle == state.lifecycle, incoming.generation > state.generation else { return false }
      var merged = incoming.merging(state.snapshot); try merged.fitBudget()
      _ = try WidgetSnapshot.decode(JSONEncoder().encode(merged))
      state.snapshot = merged; state.generation = incoming.generation
      return true
    }
  }
  func issue(for snapshot: WidgetSnapshot, now: Double) throws -> [String: String] {
    try change { state in
      guard let latest = state.snapshot, latest.scope == snapshot.scope, latest.generation == snapshot.generation,
        latest.lifecycle == snapshot.lifecycle, latest.scope == state.scope else { return [:] }
      state.tickets = state.tickets.filter { $0.value.live(scope: snapshot.scope, now: now) }
      var issued: [String: String] = [:]
      for task in snapshot.tasks.prefix(64) where task.canComplete && task.revision > 0 {
        if let old = state.tickets.first(where: { $0.value.taskId == task.id && $0.value.revision == task.revision && $0.value.providerReadRetiredGeneration == task.providerReadRetiredGeneration }) {
          issued[task.id] = old.key; continue
        }
        while state.tickets.count >= 512 {
          if let oldest = state.tickets.min(by: { $0.value.issued < $1.value.issued }) { state.tickets.removeValue(forKey: oldest.key) }
        }
        let token = UUID().uuidString
        state.tickets[token] = WidgetTaskTicket(taskId: task.id, revision: task.revision, scope: snapshot.scope,
          providerReadRetiredGeneration: task.providerReadRetiredGeneration, issued: now)
        issued[task.id] = token
      }
      return issued
    }
  }
  func consume(_ token: String, scope: String, now: Double) throws -> WidgetTaskTicket? {
    try change { state in
      guard state.scope == scope, let ticket = state.tickets[token], ticket.live(scope: scope, now: now) else { return nil }
      state.tickets.removeValue(forKey: token)
      return ticket
    }
  }
}
