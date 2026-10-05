<!-- markdownlint-disable MD013 MD033 MD041 -->

<div align="center">

<img src=".github/assets/icon.svg" alt="Musubi icon" width="96" />

# Musubi <sub><em>結び</em></sub>

**Your people. Your events. One knot.**

*An open-source, self-hostable calendar for shared events, meetings, and tasks.*

[![License: MIT](https://img.shields.io/badge/license-MIT-e8e4d9?labelColor=0c0c0e)](LICENSE)
[![Built with Expo](https://img.shields.io/badge/Expo-React%20Native-c8553d?labelColor=0c0c0e&logo=expo&logoColor=e8e4d9)](https://expo.dev)
[![Self-hostable](https://img.shields.io/badge/self--host-your%20data-a8b5a0?labelColor=0c0c0e)](#run-it-yourself)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-7a8ba3?labelColor=0c0c0e)](#contributing)

[**Website**](https://musubi.pro) · [**Docs**](https://musubi.pro/docs) · [**Discord**](https://discord.musubi.pro) · [**Roadmap**](https://feedback.musubi.pro) · [**Google Play**](https://play.google.com/store/apps/details?id=dev.frgtn.musubi)

<img src=".github/assets/banner.svg" alt="Musubi — share, sync, self-host" width="100%" />

</div>

---

## Why Musubi?

Musubi brings shared calendars, events, and tasks into one place, with a desktop web client and a native mobile app. Connect existing calendars or host a server of your own.

- **Share an event across calendars.** Link the same event to several Musubi calendars, so the people involved see one shared event. Calendar roles and event ownership determine who can edit it.
- **Share a task with the same permissions.** Link one task into several calendars; the home calendar controls editing and completion. An independent copy has its own identity and home.
- **Keep different parts of life together.** Create pages for work, family, or personal plans, with their own calendar and item-type filters.
- **Choose where your data lives.** Run the web client and API yourself with Docker. The source is MIT-licensed.

Musubi (結び) means *a knot or connection* — the idea behind bringing people and their plans together.

## What it does

| Feature | Details |
| --- | --- |
| **Shared calendars** | Invite links, owner/editor/viewer roles, ownership transfer, and live membership updates |
| **Events across calendars** | Link one event into multiple Musubi calendars, or make an independent copy |
| **Calendar views** | Day, week, month, and agenda on desktop web; date and time pickers, drag-to-create, and side-panel editing |
| **Tasks** | Status, priority, dates and home-controlled sharing across calendars; independent copies, delivery status, list/Kanban and dated calendar views. Recurring tasks cannot have multiple provider projections |
| **Meetings** | Attendee and invitation details; provider-supported RSVP and organizer editing when enabled on the server |
| **Personal pages** | Choose calendars and independently show events, tasks, and meetings |
| **External sync** | Google Calendar, Microsoft Outlook, and CalDAV connections, including iCloud; multiple accounts, recurrence, and read-only calendars |
| **Live updates** | Changes within Musubi arrive over Server-Sent Events; external calendars synchronize separately through provider polling |
| **Mobile reminders and widgets** | Local reminders and Android agenda/month home-screen widgets, with calendar filters and light/dark themes |
| **Self-hosting** | Docker Compose for the full web/API stack, an API-only setup, and a Dokploy configuration |

### Provider support

| Provider | Events | Tasks |
| --- | --- | --- |
| Google | Google Calendar | Google Tasks; task scope requested by web connections and optional in native connection setup |
| Microsoft | Outlook / Microsoft 365 | To Do home tasks and independent copies; new live task links are excluded. Task scope requested by web connections and optional in native connection setup |
| Apple / iCloud | CalDAV calendars | Depends on the task collections exposed by the server |
| Other CalDAV servers | Supported calendar collections | Collections that support VTODO |

Sync capabilities depend on the provider, permissions, and item type. A meeting you attend does not have the same editing permissions as one you organize. Some provider writes and Google free/busy availability are separately enabled by the server administrator; they are not all on by default. See [shared tasks](https://musubi.pro/docs/guides/shared-tasks/) and the current [capability matrix](https://musubi.pro/docs/operations/capabilities/). The [Core 0.2.0 activation record](docs/releases/core-0.2.0-activation.md) preserves the earlier decision and is not a new activation instruction.

The current API/web release is **0.2.2**. Every native task write needs the
0.2.2 mobile client; older clients retain task reads and compatible calendar/event
features. Installing the mobile update requires signing in again. See
[release status and upgrade precautions](https://musubi.pro/docs/operations/releases/)
for store distribution and the database recovery boundary.

> **Pre-1.0 and actively developing.** This README describes the current source branch; published app and server releases may lag behind it. Google Tasks authorization is still awaiting Google verification for the hosted project. Expect rough edges and [report issues](https://feedback.musubi.pro).

## What's next

Current work focuses on provider compatibility, reliable meeting and task workflows, and polishing the web and mobile clients. Provider push notifications are a future extension to the current polling model.

Follow the public [feedback and roadmap board](https://feedback.musubi.pro) for requests and priorities.

## Try it

<a href="https://play.google.com/store/apps/details?id=dev.frgtn.musubi">
  <img alt="Get it on Google Play" src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" height="64" />
</a>

**iOS beta:** [Join on TestFlight](https://testflight.apple.com/join/EqzdPVfC). iOS is available for testing; it is not a general App Store release yet.

## Run it yourself

**Requirements:** Node 22.12+, Corepack, Postgres 15+ (or just Docker). The
repository selects the exact pnpm version.

```sh
git clone https://github.com/f-tuma/musubi.git && cd musubi
corepack enable
pnpm install --frozen-lockfile

cp .env.example .env
# set DATABASE_URL, ENVIRONMENT, BETTER_AUTH_URL and BETTER_AUTH_SECRET

pnpm db:migrate
pnpm dev            # API + native client + web + docs
```

The client uses custom native modules, so it needs a development build rather than Expo Go. Testing on a real device? Set `BETTER_AUTH_URL` and the app's server URL (welcome screen) to your machine's LAN IP (`http://192.168.x.x:7531`), not `localhost`. `docker-compose.yml` runs the whole stack — web client, API, Postgres and a Caddy gateway that puts the first two on one origin (which the browser client requires); `docker-compose.api.yml` runs the API and Postgres alone, for mobile-only servers. Dokploy has its own `docker-compose.dokploy.yml`; add one UI Domain for `gateway` port 80, and Caddy keeps routing identical. Follow the [local development guide](https://musubi.pro/docs/guides/running-locally/) or the [self-hosting runbook](https://musubi.pro/docs/guides/self-hosting/).

## How it's built

| Layer | Tech |
| --- | --- |
| Mobile client | React Native · Expo · Expo Router · Zustand · Reanimated · custom calendar engine (`apps/client/components/cal`) · native Android `RemoteViews` widgets bridged through a local Expo module |
| Web client | React · TanStack Router/Query · Vite · Tailwind v4 · Musubi-styled shadcn/Radix components |
| Server | Express 5 · [Better Auth](https://www.better-auth.com/) · Zod · Server-Sent Events |
| Data | Postgres · [Drizzle ORM](https://orm.drizzle.team/) · SQLite on-device cache with delta sync |
| Sync engine | Provider-agnostic adapter interface (`CalendarAdapter`) — Google + Microsoft + CalDAV today, yours tomorrow |
| Monorepo | pnpm workspaces · Turborepo · [Astro Starlight](https://starlight.astro.build/) docs |

```text
apps/
  api/         Express server — auth, calendars, events, tasks, sync engine
  client/      Expo / React Native app — the custom calendar UI
  web/         TanStack web client — desktop calendar and public pages
packages/
  auth/        Better Auth config (shared client/server)
  calendar/    Recurrence logic (rrule expansion, EXDATE handling)
  db/          Drizzle schema + migrations
  docs/        Documentation site
  types/       Shared types + permission model
  config/      Env loading
```

## Contributing

The most impactful places to jump in:

- **Provider adapters** — Fastmail JMAP, Proton Calendar, anything with an API. The [sync adapter guide](https://musubi.pro/docs/architecture/sync/#how-to-add-a-provider) walks through the `CalendarAdapter` interface field-by-field.
- **Bug reports from real usage** — pre-1.0 gold.

Fork, branch, open a PR against `main`. For bigger ideas, open an issue first so we can talk it through.

## License

[MIT](LICENSE) © 2026 [FRGTN.dev](https://frgtn.dev) — take it, host it, build on it.

<div align="center">
<sub>結 — <em>tied together</em></sub>
</div>
