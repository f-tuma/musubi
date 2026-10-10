import Foundation

struct WidgetSectionStatus: Codable {
  var state: String
  var lastSyncAt: Double?
  var complete: Bool
  var truncated: Bool
  var preservePrevious: Bool?
  var coverageStart: Double?
  var coverageEnd: Double?
  var timeZone: String?
}
struct WidgetCalendar: Codable, Identifiable { var id: String; var name: String; var color: String }
struct WidgetEvent: Codable, Identifiable {
  var key: String; var id: String; var title: String; var start: Double; var end: Double
  var allDay: Bool; var color: String; var calendarName: String; var calendarIds: [String]
  var location: String; var startKey: String; var endKey: String; var taskId: String?
}
struct WidgetDay: Codable { var date: String; var eventKeys: [String] }
struct WidgetTask: Codable, Identifiable {
  var id: String; var title: String; var status: String; var priority: Int
  var color: String; var calendarName: String; var calendarIds: [String]
  var due: Double?; var dueDateOnly: Bool; var revision: Int64
  var providerReadRetiredGeneration: Int64; var canComplete: Bool; var shared: Bool
}
struct WidgetSnapshot: Codable {
  var version: Int; var scope: String; var lifecycle: Int64; var generation: Int64
  var signedIn: Bool; var generatedAt: Double; var timeZone: String
  var readableCalendarIds: [String]; var calendars: [WidgetCalendar]?
  var timeFormat: String; var weekStartsOn: String
  var eventsStatus: WidgetSectionStatus; var tasksStatus: WidgetSectionStatus
  var events: [WidgetEvent]; var calendarDays: [WidgetDay]; var tasks: [WidgetTask]

  static let byteLimit = 2_097_152
  static func decode(_ data: Data) throws -> WidgetSnapshot {
    guard data.count <= byteLimit else { throw WidgetStoreError.invalidSnapshot }
    let value = try JSONDecoder().decode(Self.self, from: data)
    let states = ["ready", "loading", "error", "unavailable"]
    guard value.version == 2, value.signedIn, !value.scope.isEmpty,
      value.lifecycle > 0, value.generation > 0, value.generatedAt.isFinite,
      TimeZone(identifier: value.timeZone) != nil,
      ["24h", "12h"].contains(value.timeFormat), ["monday", "sunday"].contains(value.weekStartsOn),
      states.contains(value.eventsStatus.state), states.contains(value.tasksStatus.state),
      let start = value.eventsStatus.coverageStart, let end = value.eventsStatus.coverageEnd,
      start.isFinite, end.isFinite, start < end,
      value.events.count <= 4096, value.tasks.count <= 2048, value.calendarDays.count <= 450,
      Set(value.events.map(\.key)).count == value.events.count,
      Set(value.tasks.map(\.id)).count == value.tasks.count,
      value.events.allSatisfy({ !$0.key.isEmpty && !$0.id.isEmpty && $0.start.isFinite && $0.end.isFinite && $0.start <= $0.end && !$0.calendarIds.isEmpty && civilDate($0.startKey) != nil && civilDate($0.endKey) != nil }),
      value.tasks.allSatisfy({ !$0.id.isEmpty && ["needs-action", "in-process"].contains($0.status) && !$0.calendarIds.isEmpty && $0.revision >= 0 && $0.providerReadRetiredGeneration >= 0 && ($0.due == nil || $0.due!.isFinite) })
    else { throw WidgetStoreError.invalidSnapshot }
    let keys = Set(value.events.map(\.key))
    guard value.calendarDays.allSatisfy({ civilDate($0.date) != nil && $0.eventKeys.allSatisfy(keys.contains) }),
      value.calendarDays.reduce(0, { $0 + $1.eventKeys.count }) <= 32768 else { throw WidgetStoreError.invalidSnapshot }
    return value
  }

  /// Retain failed sections independently, then apply the new membership barrier.
  func merging(_ previous: WidgetSnapshot?) -> WidgetSnapshot {
    var next = self
    if let previous, previous.scope == scope {
      if eventsStatus.preservePrevious == true && events.isEmpty && (!previous.events.isEmpty || previous.eventsStatus.state == "ready") {
        next.events = previous.events; next.calendarDays = previous.calendarDays
        next.eventsStatus = previous.eventsStatus
        next.eventsStatus.state = eventsStatus.state; next.eventsStatus.preservePrevious = true
        next.eventsStatus.timeZone = previous.eventsStatus.timeZone ?? previous.timeZone
      }
      if tasksStatus.preservePrevious == true && tasks.isEmpty && (!previous.tasks.isEmpty || previous.tasksStatus.state == "ready") {
        next.tasks = previous.tasks; next.tasksStatus = previous.tasksStatus
        next.tasksStatus.state = tasksStatus.state; next.tasksStatus.preservePrevious = true
        next.tasksStatus.timeZone = previous.tasksStatus.timeZone ?? previous.timeZone
      }
    }
    let readable = Set(readableCalendarIds)
    next.tasks = next.tasks.compactMap { task in
      var row = task; row.calendarIds = task.calendarIds.filter(readable.contains)
      if row.calendarIds.count != task.calendarIds.count { row.calendarName = "" }
      return row.calendarIds.isEmpty ? nil : row
    }
    if tasksStatus.state == "unavailable" && tasksStatus.preservePrevious != true { next.tasks = [] }
    let taskIds = Set(next.tasks.map(\.id))
    next.events = next.events.compactMap { event in
      var row = event; row.calendarIds = event.calendarIds.filter(readable.contains)
      if row.calendarIds.count != event.calendarIds.count { row.calendarName = "" }
      if let taskId = row.taskId {
        if tasksStatus.state == "unavailable" && tasksStatus.preservePrevious != true { return nil }
        if next.eventsStatus.preservePrevious == true && tasksStatus.preservePrevious != true && !taskIds.contains(taskId) { return nil }
      }
      return row.calendarIds.isEmpty ? nil : row
    }
    next.pruneDays()
    return next
  }
  mutating func pruneDays() {
    let keys = Set(events.map(\.key))
    calendarDays = calendarDays.compactMap { day in
      let kept = day.eventKeys.filter(keys.contains)
      return kept.isEmpty ? nil : WidgetDay(date: day.date, eventKeys: kept)
    }
  }
  mutating func fitBudget() throws {
    while try JSONEncoder().encode(self).count > Self.byteLimit {
      if !events.isEmpty {
        events.removeLast(max(1, events.count / 8)); pruneDays()
        eventsStatus.complete = false; eventsStatus.truncated = true
      } else if !tasks.isEmpty {
        tasks.removeLast(max(1, tasks.count / 8)); tasksStatus.complete = false; tasksStatus.truncated = true
      } else { throw WidgetStoreError.invalidSnapshot }
    }
  }
  func zoneMatches(_ status: WidgetSectionStatus, _ zone: TimeZone) -> Bool {
    TimeZone(identifier: status.timeZone ?? timeZone) == zone
  }
  func eventsUsable(at date: Date, zone: TimeZone) -> Bool {
    guard zoneMatches(eventsStatus, zone), let start = eventsStatus.coverageStart, let end = eventsStatus.coverageEnd else { return false }
    return date.timeIntervalSince1970 * 1000 >= start && date.timeIntervalSince1970 * 1000 < end
  }
}

func civilDate(_ key: String) -> Date? {
  let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.calendar = Calendar(identifier: .gregorian); formatter.timeZone = TimeZone(secondsFromGMT: 0)
  formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
  guard key.count == 10, let date = formatter.date(from: key), formatter.string(from: date) == key else { return nil }
  return date
}
