<!-- markdownlint-disable MD013 -->

# Musubi

> A simple, open, self-hostable calendar to tie shared time with your partner, friends, and family.

Musubi (結び) means *knot* or *tie* in Japanese. The app ties people's schedules together through shared calendars — and, eventually, ties together the calendars you already use elsewhere, becoming a single point of view across Google, Apple, and CalDAV.

> ⚠️ **Status:** Early stage. MVP-level features only, expect rough edges. Public for code-sharing and as a portfolio piece.

## Motivation

## What works today

- Create, edit, delete calendars
- Create, edit, delete events (an event can belong to multiple calendars at once)
- Invite others to a calendar via shareable link
- Join, leave, and remove calendars
- Real-time sync between connected clients (Server-Sent Events)
- Auth via [Better Auth](https://www.better-auth.com/)

## Roadmap

- **External calendar sync** — Google Calendar, Apple Calendar, CalDAV. The core "tying point" idea.
- **Plugin / extension system** — make Musubi extendable from the outside.
- **CalDAV server** — be a calendar source for other apps, not just a consumer.
- **iOS build** (Android is the current target).
- **Web client.**
- **Push notifications.**
- **Recurring events.**

## Tech stack

- **Client:** Expo SDK 55, React Native, Expo Router, Zustand, [react-native-big-calendar](https://github.com/acro5piano/react-native-big-calendar)
- **Server:** Express 5, [Better Auth](https://www.better-auth.com/), Zod
- **Database:** Postgres + [Drizzle ORM](https://orm.drizzle.team/)
- **Real-time:** Server-Sent Events
- **Monorepo:** pnpm workspaces + [Turborepo](https://turborepo.com/)
- **Docs:** [Astro Starlight](https://starlight.astro.build/)

## Project layout

```
apps/
  api/              Express server
  client/           Expo / React Native app
packages/
  auth/             Better Auth config (shared between server and client)
  config/           Shared config / env loading
  db/               Drizzle schema + migrations
  docs/             Starlight documentation site
  types/            Shared TypeScript types
```

## Quick Start

You can try the application for your self. **It will be accessible through google play store and apple app store in a few days, I will update here when process of adding is done.

More info at [Musubi Wehsite](https://musubi.frgtn.dev).

The application is setup to work with main server at the moment. Self-hostable options are on the way.

## Usage

### Requirements

- Node.js 20+
- pnpm 10+
- Postgres 15+
- [Expo Go](https://expo.dev/go) on your phone, or an Android/iOS simulator

### Setup

```sh
# Clone and install
pnpm install

# Configure environment
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and BETTER_AUTH_SECRET
# You will need your own postgres db
# Docker image for all in one is on the way

# Run database migrations
pnpm db:migrate

# Run everything in parallel (api + client + docs)
pnpm dev
```

When testing the client on a real device (not a simulator), set `API_URL` in `.env` to your machine's LAN IP — for example `http://192.168.1.42:3000` — not `localhost`.

For more detail, see [`packages/docs/`](./packages/docs/). A hosted version is planned at `musubi.frgtn.dev/docs`.

## Contributing

If you'd like to contribute, please fork the repository and open a pull request to the `main` branch.

## License

[MIT](LICENSE) © 2026 FRGTN.dev
