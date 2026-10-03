#!/usr/bin/env node
// Fails if a client asks for a URL this server does not register.
//
// The wire contract next door guards the *shape* of what crosses the wire. This
// guards the *address*. Renaming `/api/v1/calendars/:id/export` is invisible to
// every schema check in the repository and to the type system — the path is a
// string on one side and a string on the other — and it is a 404 for every
// phone build already installed, which cannot be patched.
//
// So: every `/api/…` URL that production code in apps/client or apps/web builds
// must resolve to a route registered in apps/api/src/index.ts or its explicitly
// mounted task route registrar.
//
// What it deliberately does NOT check: the HTTP method. A call site's method is
// often several lines from its URL, or passed in, and the break this exists to
// catch — a path that stopped existing — shows up in the path alone.
//
// Usage:
//   node scripts/check-routes.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const API_INDEX = resolve(root, "apps/api/src/index.ts");
const TASK_ROUTES = resolve(root, "apps/api/src/task_routes.ts");

/** Where clients are read from. Tests are excluded — they invent URLs. */
const CALLER_DIRS = ["apps/client", "apps/web/src"];
const SKIP_DIRS = new Set(["node_modules", ".expo", ".output", "dist", "e2e"]);
const SOURCE_FILE = /\.(ts|tsx)$/;
const TEST_FILE = /\.(test|spec|stories)\.(ts|tsx)$/;

const problems = [];
const fail = (message) => problems.push(message);

// --- What the server answers ------------------------------------------------

/** Registered Express routes, as their path patterns. */
function registeredRoutes() {
  const index = readFileSync(API_INDEX, "utf8");
  if (!/import \{ registerTaskRoutes \} from "\.\/task_routes"/.test(index) ||
      !/\bregisterTaskRoutes\(app\)/.test(index)) {
    fail("the task route registrar is not mounted by apps/api/src/index.ts");
  }
  const source = index + "\n" + readFileSync(TASK_ROUTES, "utf8");
  const pattern = /\bapp\.(get|post|put|patch|delete|all)\(\s*"([^"]+)"/g;
  const paths = new Set();
  for (const [, , path] of source.matchAll(pattern)) paths.add(path);
  return [...paths];
}

// --- What the clients ask for -----------------------------------------------

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) yield full;
  }
}

/**
 * What counts as a request rather than a module specifier.
 *
 * `~/api/resources` is an import, not a URL, and the web is full of them. The
 * served surface is narrower than "contains /api/": it is the versioned tree,
 * the event stream, and the Better Auth mount, so ask for one of those.
 */
const SERVED_PREFIX = /\/api\/(?:v\d+\/|stream\b|auth\/)/;

/**
 * Every request literal in a file, as (path, line) pairs.
 *
 * Both quoted strings and template literals, because the clients use both and a
 * template is the more common shape — `${apiUrl}/api/${apiVersion}/events`.
 */
function apiLiterals(source) {
  const found = [];
  for (const match of source.matchAll(/(["`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const raw = match[2].replaceAll(/\$\{\s*apiVersion\s*\}/g, "v1");
    if (!SERVED_PREFIX.test(raw)) continue;
    found.push({
      raw,
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

/**
 * Interpolations whose values are a known, closed set.
 *
 * Without these the segment would read as a wildcard, and a wildcard segment is
 * what lets `calendars/${id}/export` quietly "match" `calendars/tokens/:token`.
 * Naming the few real cases keeps every other segment strict.
 */
const ENUM_INTERPOLATIONS = { scope: ["calendars", "events"] };

/**
 * The path patterns a literal can request, or [] when it is not a request.
 *
 * More than one because of the enums above; usually exactly one.
 *
 * `${…}` is what makes this interesting. An interpolation that fills a whole
 * segment is a parameter; one glued to a literal (`import${qs}`, `events${qs}`)
 * is a query string being appended and the literal part is the real segment.
 */
function requestPaths(raw) {
  // `/api/v1/${string}` is a TypeScript template-literal *type*, not a URL, and
  // an ellipsis means the line is prose about a URL rather than one.
  if (/\$\{\s*(string|number)\s*\}/.test(raw) || raw.includes("...")) return [];

  const start = raw.indexOf("/api/");
  if (start < 0) return [];
  // Anything before /api/ is an origin; anything from ? or # on is not a path.
  const path = raw.slice(start).split(/[?#]/, 1)[0];

  // A URL has no spaces in it, so a path followed by words is a sentence that
  // mentions one — a log line, a comment, an error message. Reading those as
  // requests is how this check reports a route nobody is calling.
  if (/\s/.test(path)) return [];

  let candidates = [[]];
  for (const segment of path.split("/").slice(1)) {
    const enumerated =
      ENUM_INTERPOLATIONS[segment.match(/^\$\{\s*(\w+)\s*\}$/)?.[1]];
    const literal = segment.replaceAll(/\$\{[^}]*\}/g, "");
    // A bare `${id}` is a parameter; `import${qs}` keeps `import` and drops the
    // appended query string.
    const options =
      enumerated ??
      (literal === segment ? [segment] : [literal === "" ? ":param" : literal]);

    candidates = candidates.flatMap((prefix) =>
      options.map((option) => [...prefix, option]),
    );
  }

  return candidates.map((segments) => {
    // A trailing empty segment is a trailing slash; Express treats it as the
    // same route, and `${apiUrl}/api/v1/events${qs}` can produce one.
    while (segments.length > 1 && segments.at(-1) === "") segments.pop();
    return `/${segments.join("/")}`;
  });
}

// --- Matching ---------------------------------------------------------------

/**
 * Whether a requested path is answered by a registered route pattern.
 *
 * Strict on purpose. Letting a client's `:param` stand in for a server literal
 * looks generous and is how this check first passed a renamed route: a request
 * for `calendars/{id}/export` "matched" `calendars/tokens/:token`, which is
 * true of Express routing and useless as a contract. The question here is not
 * "would some handler answer this" but "does the route it means still exist".
 */
function matches(requested, route) {
  const wanted = requested.split("/");
  const offered = route.split("/");

  for (let index = 0; index < offered.length; index += 1) {
    const part = offered[index];
    // `{*any}` / `{*rest}` swallow the remainder — the federation gateway and
    // the Better Auth mount are both this shape.
    if (part.startsWith("{*")) return true;
    if (index >= wanted.length) return false;
    if (part.startsWith(":")) {
      if (wanted[index] !== ":param") return false;
      continue;
    }
    if (part !== wanted[index]) return false;
  }
  return wanted.length === offered.length;
}

// --- Run --------------------------------------------------------------------

const routes = registeredRoutes();
if (routes.length < 20) {
  fail(
    `only ${routes.length} routes were parsed out of apps/api/src/index.ts — ` +
      "the registration shape changed and this check is no longer reading it",
  );
}

let checked = 0;
for (const directory of CALLER_DIRS) {
  for (const file of sourceFiles(resolve(root, directory))) {
    const source = readFileSync(file, "utf8");
    for (const { raw, line } of apiLiterals(source)) {
      for (const path of requestPaths(raw)) {
        checked += 1;
        if (routes.some((route) => matches(path, route))) continue;
        fail(
          `${relative(root, file)}:${line} requests ${path}, which no route in ` +
            "apps/api/src/index.ts answers",
        );
      }
    }
  }
}

if (checked < 40) {
  fail(
    `only ${checked} client call sites were found, which is too few to be real — ` +
      "the scan stopped seeing them",
  );
}

if (problems.length > 0) {
  console.error("Route contract broken:\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    [
      "",
      "A phone build cannot be patched — every install out there keeps the URLs",
      "it was compiled with until its owner updates from the store. A route may",
      "gain a sibling; it may not lose its name.",
      "",
      "If a path genuinely has to move, keep the old one registered as well and",
      "retire it a release after MIN_CLIENT_VERSION passes it. See docs/releasing.md.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  `Route contract verified: ${checked} client call sites against ${routes.length} routes.`,
);
