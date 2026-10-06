import AppIntents
import SwiftUI
import WidgetKit

struct WidgetCalendarEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Calendar"
  static var defaultQuery = WidgetCalendarQuery()
  var id: String
  var name: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}
struct WidgetCalendarQuery: EntityQuery {
  func suggestedEntities() async throws -> [WidgetCalendarEntity] {
    guard let snapshot = try WidgetStore.shared().read().snapshot else { return [] }
    return (snapshot.calendars ?? []).filter { snapshot.readableCalendarIds.contains($0.id) }
      .map { WidgetCalendarEntity(id: snapshot.scope + "\n" + $0.id, name: $0.name) }
  }
  func entities(for identifiers: [WidgetCalendarEntity.ID]) async throws -> [WidgetCalendarEntity] {
    let ids = Set(identifiers)
    return try await suggestedEntities().filter { ids.contains($0.id) }
  }
}
struct MusubiWidgetConfiguration: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Musubi calendars"
  static var description = IntentDescription("Choose calendars for this widget. Leave the selection empty to show all calendars.")
  @Parameter(title: "Calendars") var calendars: [WidgetCalendarEntity]?
}
struct MusubiEntry: TimelineEntry {
  var date: Date
  var snapshot: WidgetSnapshot?
  var signedOut: Bool
  var calendarIds: Set<String>?
  var invalidSelection: Bool
  var tickets: [String: String]
  static func empty(at date: Date = Date()) -> Self {
    Self(date: date, snapshot: nil, signedOut: false, calendarIds: nil, invalidSelection: false, tickets: [:])
  }
}
struct MusubiProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> MusubiEntry { .empty() }
  func snapshot(for configuration: MusubiWidgetConfiguration, in context: Context) async -> MusubiEntry {
    load(configuration)
  }
  func timeline(for configuration: MusubiWidgetConfiguration, in context: Context) async -> Timeline<MusubiEntry> {
    let current = load(configuration)
    // These entries rebucket cached rows and today's marker; they do not fetch.
    // The OS decides when reload requests are serviced.
    let calendar = Calendar.current
    var dates = (0...6).compactMap { calendar.date(byAdding: .hour, value: $0, to: current.date) }
    if let midnight = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: current.date)) { dates.append(midnight) }
    let entries = dates.sorted().map { date -> MusubiEntry in var entry = current; entry.date = date; return entry }
    return Timeline(entries: entries, policy: .after(current.date.addingTimeInterval(3600)))
  }
  private func load(_ configuration: MusubiWidgetConfiguration) -> MusubiEntry {
    var entry = MusubiEntry.empty()
    do {
      let store = try WidgetStore.shared()
      let state = try store.read()
      entry.snapshot = state.snapshot; entry.signedOut = state.scope == nil
      if let snapshot = state.snapshot {
        let selected = configuration.calendars ?? []
        if !selected.isEmpty {
          let all = Set(snapshot.readableCalendarIds.map { snapshot.scope + "\n" + $0 })
          entry.invalidSelection = !selected.allSatisfy { all.contains($0.id) }
          entry.calendarIds = Set(snapshot.readableCalendarIds.filter { id in selected.contains { $0.id == snapshot.scope + "\n" + id } })
        }
        entry.tickets = (try? store.issue(for: snapshot, now: entry.date.timeIntervalSince1970 * 1000)) ?? [:]
      }
    } catch { /* Missing, protected or corrupt data is unknown, never empty. */ }
    return entry
  }
}

enum MusubiWidgetKind { case agenda, calendar, tasks
  var route: String { self == .tasks ? "tasks" : self == .agenda ? "agenda" : "" }
  var title: String { self == .tasks ? "Tasks" : self == .calendar ? "Calendar" : "Agenda" }
}
func widgetURL(_ route: String = "", _ query: [String: String] = [:]) -> URL {
  var components = URLComponents(string: route.isEmpty ? "musubi:///" : "musubi://\(route)")!
  components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
  return components.url!
}
func pigment(_ value: String, fallback: Color) -> Color {
  let hex = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
  guard hex.count == 6, let rgb = UInt32(hex, radix: 16) else { return fallback }
  return Color(.sRGB, red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255, opacity: 1)
}

struct MusubiWidgetView: View {
  let entry: MusubiEntry
  let kind: MusubiWidgetKind
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var scheme
  @Environment(\.dynamicTypeSize) private var dynamicType
  @ScaledMetric(relativeTo: .headline) private var headerSize = WidgetTokens.Typography.headerTitleSize
  @ScaledMetric(relativeTo: .body) private var titleSize = WidgetTokens.Typography.titleSize
  @ScaledMetric(relativeTo: .caption) private var metaSize = WidgetTokens.Typography.metaSize
  @ScaledMetric(relativeTo: .body) private var rowHeight = WidgetTokens.Layout.iosRowHeight
  private var small: Bool { family == .systemSmall }
  private var ink: Color { WidgetTokens.foreground(scheme) }
  private var muted: Color { WidgetTokens.foregroundMuted(scheme) }
  private var selectedEvents: [WidgetEvent] {
    guard let snapshot = entry.snapshot, snapshot.eventsUsable(at: entry.date, zone: .current) else { return [] }
    return snapshot.events.filter { event in
      (event.allDay ? event.endKey >= dayKey(entry.date) : event.end >= entry.date.timeIntervalSince1970 * 1000)
        && (entry.calendarIds == nil || event.calendarIds.contains { entry.calendarIds!.contains($0) })
    }.sorted { $0.start == $1.start ? $0.key < $1.key : $0.start < $1.start }
  }
  private var selectedTasks: [WidgetTask] {
    guard let snapshot = entry.snapshot, snapshot.zoneMatches(snapshot.tasksStatus, .current) else { return [] }
    return snapshot.tasks.filter { task in entry.calendarIds == nil || task.calendarIds.contains { entry.calendarIds!.contains($0) } }
  }
  var body: some View {
    GeometryReader { geometry in
      VStack(alignment: .leading, spacing: WidgetTokens.Layout.rowGap) {
        header
        if let problem = problem {
          Text(problem).font(.system(size: titleSize)).foregroundStyle(muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        } else if kind == .calendar && !small && family != .systemMedium {
          monthGrid(height: geometry.size.height - WidgetTokens.Layout.iosHeaderHeight - WidgetTokens.Layout.iosFooterHeight)
        } else if kind == .calendar && small {
          todayCard
        } else if kind == .tasks {
          taskRows(count: capacity(geometry.size.height))
        } else {
          agendaRows(count: capacity(geometry.size.height))
        }
        footer
      }
      .foregroundStyle(ink)
    }
    .containerBackground(for: .widget) { WidgetTokens.surface(scheme) }
    .widgetURL(widgetURL(kind.route))
    .privacySensitive()
  }
  private func capacity(_ height: CGFloat) -> Int {
    max(0, min(12, Int((height - WidgetTokens.Layout.iosHeaderHeight - WidgetTokens.Layout.iosFooterHeight - WidgetTokens.Layout.contentGap) / (rowHeight + WidgetTokens.Layout.rowGap))))
  }
  private var problem: String? {
    guard let snapshot = entry.snapshot else { return entry.signedOut ? "Sign in to Musubi" : "Open Musubi to load data" }
    if entry.invalidSelection { return "Choose calendars in Edit Widget" }
    let status = kind == .tasks ? snapshot.tasksStatus : snapshot.eventsStatus
    if !snapshot.zoneMatches(status, .current) { return "Open Musubi to update time zone" }
    if kind != .tasks && !snapshot.eventsUsable(at: entry.date, zone: .current) { return "Open Musubi to update dates" }
    if status.state == "unavailable" { return "Open Musubi to reload" }
    return nil
  }
  private var header: some View {
    HStack(alignment: .center, spacing: WidgetTokens.Layout.contentGap) {
      Text(kind == .tasks ? "Tasks \(selectedTasks.count)" : kind == .calendar ? entry.date.formatted(.dateTime.month(.wide).year()) : entry.date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)))
        .font(.system(size: headerSize, weight: .semibold, design: kind == .tasks ? .default : .serif))
        .lineLimit(1)
      Spacer(minLength: 0)
      if !small && entry.snapshot != nil && !dynamicType.isAccessibilitySize {
        Link(destination: widgetURL(kind == .tasks ? "tasks" : "", ["widgetAdd": "1"])) {
          Image(systemName: "plus").font(.system(size: WidgetTokens.Layout.controlIconSize))
            .frame(width: WidgetTokens.Layout.controlSize, height: WidgetTokens.Layout.iosHeaderHeight)
        }.accessibilityLabel(kind == .tasks ? "Add task" : "Add event")
      }
    }.frame(minHeight: WidgetTokens.Layout.iosHeaderHeight)
  }
  private var footer: some View {
    HStack(spacing: WidgetTokens.Layout.contentGap) {
      if let snapshot = entry.snapshot {
        let status = kind == .tasks ? snapshot.tasksStatus : snapshot.eventsStatus
        Group {
          if status.state == "error" { Text("Could not update · cached data") }
          else if status.state == "loading" { Text("Updating · cached data") }
          else if !status.complete || status.truncated { Text("Open Musubi for more") }
          else if let synced = status.lastSyncAt { Text(Date(timeIntervalSince1970: synced / 1000), style: .relative) }
          else { Text("Cached data") }
        }.font(.system(size: metaSize)).foregroundStyle(muted).lineLimit(1)
      }
      Spacer(minLength: 0)
      if !small {
        Link(destination: widgetURL(kind.route, ["widgetRefresh": "1"])) {
          Image(systemName: "arrow.clockwise").font(.system(size: WidgetTokens.Layout.controlIconSize))
            .frame(width: WidgetTokens.Layout.controlSize, height: WidgetTokens.Layout.iosFooterHeight)
        }.accessibilityLabel("Refresh in Musubi")
      }
    }.frame(minHeight: WidgetTokens.Layout.iosFooterHeight)
  }
  private func empty(_ status: WidgetSectionStatus?, tasks: Bool) -> String {
    guard let status else { return "Open Musubi to load data" }
    if status.state == "error" { return "Open Musubi to retry loading" }
    if status.state == "loading" { return "Loading" }
    if !status.complete || status.truncated { return "Open Musubi for more" }
    return tasks ? "All caught up" : "No upcoming events"
  }
  private func taskRows(count: Int) -> some View {
    VStack(alignment: .leading, spacing: WidgetTokens.Layout.rowGap) {
      if count == 0 { Text("Open Musubi to see tasks").font(.system(size: titleSize)).foregroundStyle(muted) }
      else if selectedTasks.isEmpty { Text(empty(entry.snapshot?.tasksStatus, tasks: true)).font(.system(size: titleSize)).foregroundStyle(muted) }
      else {
        ForEach(Array(selectedTasks.prefix(count))) { task in
          HStack(spacing: WidgetTokens.Layout.contentGap) {
            if small { taskSymbol(task) }
            else {
              Link(destination: widgetURL("tasks", ["taskId": task.id].merging(entry.tickets[task.id].map { ["widgetComplete": $0] } ?? [:], uniquingKeysWith: { _, value in value }))) { taskSymbol(task) }
                .accessibilityLabel(entry.tickets[task.id] != nil ? "Complete \(task.title)" : "Open \(task.title)")
            }
            rowLink(widgetURL("tasks", ["taskId": task.id])) {
              VStack(alignment: .leading, spacing: 0) {
                Text(task.title).font(.system(size: titleSize, weight: .medium)).lineLimit(1)
                Text(taskMeta(task)).font(.system(size: metaSize)).foregroundStyle(taskOverdue(task) ? WidgetTokens.accentText(scheme) : muted).lineLimit(1)
              }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if task.shared {
              Image(systemName: "person.2").font(.system(size: WidgetTokens.Layout.metaIconSize))
                .foregroundStyle(muted).frame(width: WidgetTokens.Layout.controlSize)
                .accessibilityLabel("Shared task")
            }
          }.frame(height: rowHeight)
        }
      }
      Spacer(minLength: 0)
    }.frame(maxHeight: .infinity, alignment: .topLeading)
  }
  private func taskSymbol(_ task: WidgetTask) -> some View {
    Image(systemName: task.canComplete ? "circle" : "lock")
      .font(.system(size: WidgetTokens.Layout.taskCheckSize))
      .foregroundStyle(task.canComplete ? pigment(task.color, fallback: WidgetTokens.accent(scheme)) : muted)
      .frame(width: WidgetTokens.Layout.controlSize, height: rowHeight)
  }
  private func taskOverdue(_ task: WidgetTask) -> Bool {
    guard let due = task.due else { return false }
    return task.dueDateOnly ? civilDue(task) < Calendar.current.startOfDay(for: entry.date) : due < entry.date.timeIntervalSince1970 * 1000
  }
  private func civilDue(_ task: WidgetTask) -> Date {
    let date = Date(timeIntervalSince1970: (task.due ?? 0) / 1000)
    var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(secondsFromGMT: 0)!
    return Calendar.current.date(from: utc.dateComponents([.year, .month, .day], from: date)) ?? date
  }
  private func taskMeta(_ task: WidgetTask) -> String {
    guard let due = task.due else { return task.calendarName }
    let date = task.dueDateOnly ? civilDue(task) : Date(timeIntervalSince1970: due / 1000)
    let label = Calendar.current.isDate(date, inSameDayAs: entry.date) ? "Today" : date.formatted(.dateTime.month(.abbreviated).day())
    return taskOverdue(task) ? "Overdue · \(label)" : label
  }
  @ViewBuilder private func rowLink<Content: View>(_ url: URL, @ViewBuilder content: () -> Content) -> some View {
    if small { content() } else { Link(destination: url, label: content) }
  }
  private func agendaRows(count: Int) -> some View {
    VStack(alignment: .leading, spacing: WidgetTokens.Layout.rowGap) {
      if count == 0 { Text("Open Musubi to see events").font(.system(size: titleSize)).foregroundStyle(muted) }
      else if selectedEvents.isEmpty { Text(empty(entry.snapshot?.eventsStatus, tasks: false)).font(.system(size: titleSize)).foregroundStyle(muted) }
      else {
        ForEach(Array(selectedEvents.prefix(count)), id: \.key) { event in
          rowLink(eventURL(event)) {
            HStack(spacing: WidgetTokens.Layout.contentGap) {
              if !small {
                Text(event.allDay ? "All day" : time(event.start)).font(.system(size: metaSize))
                  .foregroundStyle(muted).frame(width: WidgetTokens.Layout.timeColumnWidth, alignment: .leading)
              }
              RoundedRectangle(cornerRadius: WidgetTokens.Layout.stripeWidth)
                .fill(pigment(event.color, fallback: WidgetTokens.accent(scheme))).frame(width: WidgetTokens.Layout.stripeWidth)
              VStack(alignment: .leading, spacing: 0) {
                Text(event.title).font(.system(size: titleSize, weight: .medium)).lineLimit(1)
                Text(event.allDay ? event.calendarName : (small ? time(event.start) : event.location.isEmpty ? event.calendarName : event.location))
                  .font(.system(size: metaSize)).foregroundStyle(muted).lineLimit(1)
              }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(height: rowHeight)
          }.accessibilityLabel("\(event.title), \(event.allDay ? "all day" : time(event.start))")
        }
      }
      Spacer(minLength: 0)
    }.frame(maxHeight: .infinity, alignment: .topLeading)
  }
  private func time(_ milliseconds: Double) -> String {
    let formatter = DateFormatter(); formatter.locale = Locale.current; formatter.timeZone = .current
    formatter.dateFormat = entry.snapshot?.timeFormat == "12h" ? "h:mm a" : "HH:mm"
    return formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000))
  }
  private func eventURL(_ event: WidgetEvent) -> URL {
    if let taskId = event.taskId { return widgetURL("tasks", ["taskId": taskId]) }
    return widgetURL("agenda", ["eventId": event.id, "occurrenceStart": String(Int64(event.start))])
  }
  private var todayCard: some View {
    VStack(alignment: .leading, spacing: WidgetTokens.Layout.contentGap) {
      Text(entry.date.formatted(.dateTime.day())).font(.system(size: WidgetTokens.Typography.markSize, weight: .semibold, design: .serif)).foregroundStyle(WidgetTokens.accentText(scheme))
      Text(entry.date.formatted(.dateTime.weekday(.wide))).font(.system(size: titleSize)).lineLimit(1)
      Text(selectedEvents.first?.title ?? empty(entry.snapshot?.eventsStatus, tasks: false)).font(.system(size: metaSize)).foregroundStyle(muted).lineLimit(1)
      Spacer(minLength: 0)
    }.frame(maxHeight: .infinity, alignment: .topLeading)
  }
  private func monthGrid(height: CGFloat) -> some View {
    let dates = monthDates()
    let first = entry.snapshot?.weekStartsOn == "sunday" ? 1 : 2
    let symbols = Calendar.current.veryShortStandaloneWeekdaySymbols
    let cellHeight = (height - WidgetTokens.Layout.calendarWeekdayHeight - WidgetTokens.Layout.contentGap) / 6
    return VStack(spacing: 0) {
      if cellHeight < titleSize + WidgetTokens.Layout.calendarDotRowHeight {
        Text("Open Musubi to see dates").font(.system(size: titleSize)).foregroundStyle(muted).frame(maxHeight: .infinity)
      } else {
        HStack(spacing: 0) {
          ForEach(0..<7, id: \.self) { index in Text(symbols[(index + first - 1) % 7]).font(.system(size: metaSize)).foregroundStyle(muted).frame(maxWidth: .infinity) }
        }.frame(height: WidgetTokens.Layout.calendarWeekdayHeight)
        ForEach(0..<6, id: \.self) { row in
          HStack(spacing: 0) {
            ForEach(0..<7, id: \.self) { column in
              let date = dates[row * 7 + column]
              Link(destination: widgetURL("", ["time": String(Int64(date.timeIntervalSince1970 * 1000))])) {
                VStack(spacing: 0) {
                  Text(date.formatted(.dateTime.day())).font(.system(size: titleSize, weight: Calendar.current.isDate(date, inSameDayAs: entry.date) ? .semibold : .regular))
                    .foregroundStyle(Calendar.current.isDate(date, inSameDayAs: entry.date) ? WidgetTokens.onAccent(scheme) : Calendar.current.isDate(date, equalTo: entry.date, toGranularity: .month) ? ink : muted)
                    .frame(width: titleSize + WidgetTokens.Layout.contentGap, height: titleSize + WidgetTokens.Layout.contentGap)
                    .background { if Calendar.current.isDate(date, inSameDayAs: entry.date) { Circle().fill(WidgetTokens.accent(scheme)) } }
                    .frame(maxHeight: .infinity)
                  HStack(spacing: WidgetTokens.Layout.calendarDotGap) {
                    ForEach(Array(dayEvents(date).prefix(3)), id: \.key) { event in Circle().fill(pigment(event.color, fallback: WidgetTokens.accent(scheme))).frame(width: WidgetTokens.Layout.calendarDotSize, height: WidgetTokens.Layout.calendarDotSize) }
                  }.frame(height: WidgetTokens.Layout.calendarDotRowHeight)
                }.frame(maxWidth: .infinity).frame(height: cellHeight)
              }.accessibilityLabel("\(date.formatted(date: .complete, time: .omitted)), \(dayEvents(date).count) events")
            }
          }
        }
      }
    }.frame(maxHeight: .infinity)
  }
  private func monthDates() -> [Date] {
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current
    let start = calendar.date(from: calendar.dateComponents([.year, .month], from: entry.date))!
    let first = entry.snapshot?.weekStartsOn == "sunday" ? 1 : 2
    let offset = (calendar.component(.weekday, from: start) - first + 7) % 7
    let gridStart = calendar.date(byAdding: .day, value: -offset, to: start)!
    return (0..<42).map { calendar.date(byAdding: .day, value: $0, to: gridStart)! }
  }
  private func dayKey(_ date: Date) -> String {
    let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = .current; formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
  }
  private func dayEvents(_ date: Date) -> [WidgetEvent] {
    guard let snapshot = entry.snapshot else { return [] }
    let key = dayKey(date)
    let keys = Set(snapshot.calendarDays.first { $0.date == key }?.eventKeys ?? [])
    return snapshot.events.filter { keys.contains($0.key) && (entry.calendarIds == nil || $0.calendarIds.contains { entry.calendarIds!.contains($0) }) }
  }
}

struct MusubiAgendaWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "MusubiAgenda", intent: MusubiWidgetConfiguration.self, provider: MusubiProvider()) { MusubiWidgetView(entry: $0, kind: .agenda) }
      .configurationDisplayName("Musubi Agenda").description("Upcoming events from your calendars.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
  }
}
struct MusubiCalendarWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "MusubiCalendar", intent: MusubiWidgetConfiguration.self, provider: MusubiProvider()) { MusubiWidgetView(entry: $0, kind: .calendar) }
      .configurationDisplayName("Musubi Calendar").description("Your month and upcoming events.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
  }
}
struct MusubiTasksWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "MusubiTasks", intent: MusubiWidgetConfiguration.self, provider: MusubiProvider()) { MusubiWidgetView(entry: $0, kind: .tasks) }
      .configurationDisplayName("Musubi Tasks").description("Open tasks and their due dates.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
  }
}
@main struct MusubiWidgets: WidgetBundle {
  var body: some Widget { MusubiAgendaWidget(); MusubiCalendarWidget(); MusubiTasksWidget() }
}
