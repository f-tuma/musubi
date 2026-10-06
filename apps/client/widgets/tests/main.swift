import Foundation

let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: directory) }
let store = WidgetStore(url: directory.appendingPathComponent("state.json"))
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  guard try condition() else { fatalError(message) }
}
func fixture(scope: String = "one", lifecycle: Int64 = 1, generation: Int64 = 1) throws -> WidgetSnapshot {
  let raw = """
  {"version":2,"scope":"one","lifecycle":1,"generation":1,"signedIn":true,"generatedAt":1,"timeZone":"Europe/Prague",
  "readableCalendarIds":["home","mirror"],"calendars":[{"id":"home","name":"Home","color":"#ffffff"}],"timeFormat":"24h","weekStartsOn":"monday",
  "eventsStatus":{"state":"ready","lastSyncAt":1,"complete":true,"truncated":false,"coverageStart":0,"coverageEnd":4102444800000},
  "tasksStatus":{"state":"ready","lastSyncAt":1,"complete":true,"truncated":false},
  "events":[{"key":"event","id":"event","title":"Meeting","start":1,"end":2,"allDay":false,"color":"#ffffff","calendarName":"Home","calendarIds":["home"],"location":"","startKey":"2026-10-06","endKey":"2026-10-06"},
  {"key":"marker","id":"task","taskId":"task","title":"Task","start":1,"end":2,"allDay":false,"color":"#ffffff","calendarName":"Home","calendarIds":["home","mirror"],"location":"","startKey":"2026-10-06","endKey":"2026-10-06"}],
  "calendarDays":[{"date":"2026-10-06","eventKeys":["event","marker"]}],
  "tasks":[{"id":"task","title":"Task","status":"needs-action","priority":0,"color":"#ffffff","calendarName":"Home","calendarIds":["home","mirror"],"due":null,"dueDateOnly":false,"revision":2,"providerReadRetiredGeneration":3,"canComplete":true,"shared":true}]}
  """
  var snapshot = try WidgetSnapshot.decode(Data(raw.utf8))
  snapshot.scope = scope; snapshot.lifecycle = lifecycle; snapshot.generation = generation
  return snapshot
}
try check(try store.begin("one") == 1, "First lifecycle")
let first = try fixture()
try check(try store.write(JSONEncoder().encode(first)), "Initial write")
try check(!(try store.write(JSONEncoder().encode(first))), "Same generation must be fenced")
var late = first; late.lifecycle = 0
try check((try? store.write(JSONEncoder().encode(late))) == nil, "Malformed lifecycle rejected")
let issued = try store.issue(for: first, now: 100)
try check(issued.count == 1, "One canonical task ticket")
let token = issued["task"]!
try check(try store.consume(token, scope: "foreign", now: 101) == nil, "Scope bound")
let taken = try store.consume(token, scope: "one", now: 101)
try check(taken?.revision == 2 && taken?.providerReadRetiredGeneration == 3, "CAS bound")
try check(try store.consume(token, scope: "one", now: 102) == nil, "Single use")
let expiry = try store.issue(for: first, now: 200)["task"]!
try check(try store.consume(expiry, scope: "one", now: 86_400_201) == nil, "Expiry")
var failed = try fixture(generation: 2)
failed.events = []; failed.calendarDays = []; failed.tasks = []
failed.eventsStatus.state = "error"; failed.eventsStatus.preservePrevious = true
failed.tasksStatus.state = "error"; failed.tasksStatus.preservePrevious = true
try check(try store.write(JSONEncoder().encode(failed)), "Independent failed sections accepted")
let retained = try store.read().snapshot!
try check(retained.events.count == 2 && retained.tasks.count == 1 && retained.eventsStatus.lastSyncAt == 1, "Same scope retention")
var removed = failed; removed.generation = 3; removed.readableCalendarIds = ["mirror"]
try check(try store.write(JSONEncoder().encode(removed)), "Membership barrier")
let pruned = try store.read().snapshot!
try check(pruned.events.count == 1 && pruned.tasks[0].calendarIds == ["mirror"] && pruned.tasks[0].calendarName.isEmpty, "Revoked membership cannot leak")
try check(pruned.calendarDays[0].eventKeys == ["marker"], "Orphan references pruned")
var forbidden = removed; forbidden.generation = 4
forbidden.tasksStatus.state = "unavailable"; forbidden.tasksStatus.preservePrevious = false
try check(try store.write(JSONEncoder().encode(forbidden)), "Authorization barrier")
try check(try store.read().snapshot!.tasks.isEmpty && store.read().snapshot!.events.isEmpty, "Task markers removed with auth loss")
let secondLifecycle = try store.begin("two")
try check(secondLifecycle == 2 && store.read().snapshot == nil, "Account reset clears display rows")
try check(!(try store.write(JSONEncoder().encode(first))), "Late old account writer")
try check(try store.consume(expiry, scope: "one", now: 201) == nil, "Account reset clears actions")
try check(try store.write(JSONEncoder().encode(fixture(scope: "two", lifecycle: secondLifecycle))), "New account write")
try store.clear()
try check(try store.read().scope == nil && store.read().snapshot == nil, "Sign out")
try Data("broken".utf8).write(to: store.url)
try store.clear()
try check(try store.read().scope == nil, "Corrupt cache cannot prevent sign out")
var duplicate = first; duplicate.tasks += duplicate.tasks
try check((try? WidgetSnapshot.decode(JSONEncoder().encode(duplicate))) == nil, "Duplicate canonical rows rejected")
try check(civilDate("2026-02-30") == nil && civilDate("2026-2-01") == nil && civilDate("2024-02-29") != nil, "Strict civil dates")
try check(first.zoneMatches(first.tasksStatus, TimeZone(identifier: "Europe/Prague")!), "Device zone")
try check(!first.eventsUsable(at: Date(), zone: TimeZone(identifier: "America/New_York")!), "Zone changes do not publish stale expansion")
print("Swift widget storage, retention, membership, action and lifecycle invariants: OK")
