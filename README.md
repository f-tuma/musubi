<!-- markdownlint-disable MD013 MD033 MD041 -->

<div align="center">

<img src=".github/assets/icon.png" alt="Musubi icon" width="96" style="border-radius: 22px" />

# Musubi <sub><em>結び</em></sub>

**Your people. Your events. One knot.**

*The open-source, self-hostable calendar built for sharing — not just storing — your time.*

[![License: MIT](https://img.shields.io/badge/license-MIT-e8e4d9?labelColor=0c0c0e)](LICENSE)
[![Built with Expo](https://img.shields.io/badge/Expo-SDK%2056-c8553d?labelColor=0c0c0e&logo=expo&logoColor=e8e4d9)](https://expo.dev)
[![Self-hostable](https://img.shields.io/badge/self--host-your%20data-a8b5a0?labelColor=0c0c0e)](#-run-it-yourself)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-7a8ba3?labelColor=0c0c0e)](#-contributing)

[**Website**](https://musubi.frgtn.dev) · [**Docs**](https://musubi.frgtn.dev/docs) · [**Roadmap**](https://github.com/users/f-tuma/projects/2) · [**Google Play**](https://play.google.com/store/apps/details?id=dev.frgtn.musubi)

<img src=".github/assets/banner.svg" alt="Musubi — share, sync, self-host" width="100%" />

</div>

---

## Why Musubi?

Every calendar app treats **sharing as an afterthought**. Google Calendar locks your family into Google. Apple locks them into Apple. CalDAV apps sync, but sharing means emailing `.ics` attachments like it's 2009. And planning something with friends? That somehow still belongs to Facebook.

**Musubi** (結び — *the knot*) starts from the other end: **the people come first, the events tie you together.**

- 🪢 **Events are freed from calendars.** An event isn't trapped in one calendar — link it into your partner's, your team's, your friends'. One dinner, visible everywhere it matters, edited once.
- 🌐 **One node for your whole life.** Work, family, relationship, friends — separate calendars, separate people, one unified view. Your external Google / Apple / CalDAV events flow in and out through two-way sync.
- 🏠 **Your server, your data.** Self-host the whole thing with Docker, or use it hosted. No ads, no profile building, MIT-licensed.

Nobody else is building exactly this: **an open calendar designed as social infrastructure, without being a social network.**

<div align="center">
<img src=".github/assets/phone.svg" alt="Musubi month view with the quick composer" width="300" />

<sub>Month view with the docked quick-composer — zen ink-on-paper theme, light & dark.</sub>
</div>

## What it does today

| | Feature | Details |
|---|---|---|
| 結 | **Shared calendars** | Invite via link, roles (owner / editor / viewer), ownership transfer, live membership |
| 空 | **Events beyond calendars** | One event in many calendars — link it, fork it, or keep it yours; the origin calendar governs editing |
| 繋 | **Two-way external sync** | Google Calendar, Apple / iCloud, and any CalDAV server — including recurring events *with exceptions*, read-only detection, multiple accounts |
| 速 | **Realtime** | Changes appear on everyone's device instantly (Server-Sent Events), with an offline-tolerant delta cache underneath |
| 月 | **A calendar UI built from scratch** | Month → day zoom animation, drag-to-create with grab handles, docked quick-composer — Google Calendar fluency, none of the Google |
| 侘 | **Zen aesthetic** | Sumi ink on night / ink on washi paper, spring physics, deliberate haptics, kanji accents |
| 鈴 | **Notifications** | Local reminders that survive edits, moves, and recurrence — even for synced events |
| 家 | **Self-hosting** | One Postgres + one Node server, `docker-compose.yml` included |

### Sync providers

| Provider | Status |
|---|---|
| Google Calendar | ✅ two-way |
| Apple / iCloud | ✅ two-way (CalDAV) |
| Any CalDAV server (Nextcloud, Radicale, Fastmail…) | ✅ two-way |
| Outlook / Microsoft 365 | 🚧 planned — [adapter guide](https://musubi.frgtn.dev/docs) is ready if you want to build it |

## Where it's going

The mobile app + self-hostable server are the foundation. The bigger picture:

- 🚧 **Web client** — a first-class web app, not a mobile afterthought. Power features live here: rich planning views, bulk editing, calendar administration.
- 🚧 **Open events & RSVP** — create an event, share a link. People join as attendees with **just a name and an email**. No account, no app install, no social network. You see who's coming; they get email reminders. *This is our shot at everything Facebook Events used to be — without Facebook.*
- 🚧 **Meetup planning** — find the time that works across everyone's calendars before the event exists.
- 🚧 **Realtime provider push** — webhook-driven sync from Google/Outlook instead of polling (design done, see docs).
- 🔮 **Email notifications, attendance tracking, public event pages.**

Full backlog on the [roadmap board](https://github.com/users/f-tuma/projects/2).

> ⚠️ **Status: early.** Musubi is pre-1.0 and moving fast. It already runs daily on real devices, but expect sharp edges — and please [report them](https://github.com/f-tuma/Musubi/issues).

## 📱 Try it

<a href="https://play.google.com/store/apps/details?id=dev.frgtn.musubi">
  <img alt="Get it on Google Play" src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" height="64" />
</a>

iOS build is planned once the Android client settles.

## 🏠 Run it yourself

**Requirements:** Node 20+, pnpm 10+, Postgres 15+ (or just Docker).

```sh
git clone https://github.com/f-tuma/Musubi.git && cd Musubi
pnpm install

cp .env.example .env
# set DATABASE_URL and BETTER_AUTH_SECRET at minimum

pnpm db:migrate
pnpm dev            # api + client + docs, all in parallel
```

Testing on a real device? Point `API_URL` at your machine's LAN IP (`http://192.168.x.x:3000`), not `localhost`. There's a `docker-compose.yml` at the repo root for the server + database. Full guides live in [`packages/docs`](./packages/docs/) and at [musubi.frgtn.dev/docs](https://musubi.frgtn.dev/docs).

## 🧱 How it's built

| Layer | Tech |
|---|---|
| Mobile client | React Native 0.85 · Expo SDK 56 · Expo Router · Zustand · Reanimated · custom calendar engine (`apps/client/components/cal`) |
| Server | Express 5 · [Better Auth](https://www.better-auth.com/) · Zod · Server-Sent Events |
| Data | Postgres · [Drizzle ORM](https://orm.drizzle.team/) · SQLite on-device cache with delta sync |
| Sync engine | Provider-agnostic adapter interface (`CalendarAdapter`) — Google + CalDAV today, yours tomorrow |
| Monorepo | pnpm workspaces · Turborepo · [Astro Starlight](https://starlight.astro.build/) docs |

```text
apps/
  api/         Express server — auth, calendars, events, sync engine
  client/      Expo / React Native app — the custom calendar UI
packages/
  auth/        Better Auth config (shared client/server)
  calendar/    Recurrence logic (rrule expansion, EXDATE handling)
  db/          Drizzle schema + migrations
  docs/        Documentation site
  types/       Shared types + permission model
  config/      Env loading
```

## 🤝 Contributing

The most impactful places to jump in:

- **Provider adapters** — Outlook, Fastmail JMAP, anything with an API. The [sync adapter guide](https://musubi.frgtn.dev/docs) walks you through the `CalendarAdapter` interface, field-by-field.
- **The web client** — greenfield, starting soon.
- **Bug reports from real usage** — pre-1.0 gold.

Fork, branch, open a PR against `main`. For bigger ideas, open an issue first so we can talk it through.

## License

[MIT](LICENSE) © 2026 [FRGTN.dev](https://frgtn.dev) — take it, host it, build on it.

<div align="center">
<sub>結 — <em>tied together</em></sub>
</div>
