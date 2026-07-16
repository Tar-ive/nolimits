# NoLimits for iOS

Generate and open the project:

```sh
cd ios
xcodegen generate --spec project.yml
open NoLimits.xcodeproj
```

The app defaults to the Railway deployment and never receives provider tokens.
Authenticate with Claude, Codex, and Cursor on the Mac, then sync the Mac
credentials into the shared Upstash Redis:

```sh
npm run auth:sync-mac
```

The iPhone only calls `/auth/*/status` and `/usage/*` on Railway.

The app includes real WidgetKit widgets:

- **Provider Limits** — configurable provider bars and rings.
- **Limits Overview** — a five-provider Home Screen summary.
- **Lock Screen** — inline, circular, and rectangular families.

Add them from the iOS Home Screen widget gallery. Opening or refreshing the
app reloads widget timelines; iOS also refreshes them periodically.
