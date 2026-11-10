![Banner](https://res.cloudinary.com/boidu/image/upload/t_banner/v1759536833/bl/banner.png)

# Better Lyrics — Standalone Web Player

Time-synced, per-syllable lyrics for your **local music library**, in a standalone, locally served web player. This repository is the web port of the [Better Lyrics browser extension](https://github.com/better-lyrics/better-lyrics) for YouTube Music™ — same renderer, same themes, same providers — rebuilt to run against the files on your machine. GPL-3.0 licensed, free forever.

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Running in production](#running-in-production)
- [How the app finds lyrics](#how-the-app-finds-lyrics)
- [Settings](#settings)
- [Demo mode](#demo-mode)
- [Privacy](#privacy)
- [FAQ](#faq)
- [Development](#development)
- [Theming](#theming)
- [Contributing](#contributing)
- [License](#license)
- [Privacy Policy](#privacy-policy)
- [Trademarks](#trademarks)
- [Contributors ✨](#contributors-)

## Features

🎵 Per-syllable, per-word and per-line synced lyrics, rendered karaoke-style\
📁 Plays your local library — drag & drop audio files, or a scanned library index\
🎚️ Stable track identity (path + content hash), per-track/per-source offsets, global + sync-type trims\
🌏 Translation and romanization for foreign-language tracks\
🌐 UI available in 24 languages\
🎨 Built-in themes (Default, HDR) and a full theme editor with live preview\
🖥️ Full-screen mode with an auto-hiding controls dock\
🪶 Local-first: your files and your embedded lyrics never leave your machine\

## Requirements

- **Node.js ≥ 22.12** (see `engines` in `package.json`)
- npm 10+
- A folder of audio files (FLAC/MP3/M4A/OGG/OPUS/WAV/…) — optional; you can also drag & drop files into the app, or try the bundled demo fixtures

## Quick start

```shell
npm install
mkdir -p music          # put your audio files here (git-ignored)
npm run library         # scan ./music → public/library.json (tags, art, track ids)
npm run dev             # → http://localhost:5173
```

Drop sidecar lyrics next to your audio with the same basename and any of `.lrc`, `.ttml`, `.srt`, `.vtt` — they are picked up by the scanner and marked with their sync type. Embedded cover art is extracted to `public/library-art/`; lyrics embedded in the file itself are read live in the browser. Nothing is copied out of your library folder.

Open the app, pick or drag in a track, and press play. The settings page lives at [`/settings.html`](settings.html) (gear icon in the player).

> [!TIP]
>
> No music at hand? Run `npm run dev` and open `http://localhost:5173/?demo=apple-nested` — the demo track streams from disk with its fixture lyrics. See [docs/demo-fixtures.md](docs/demo-fixtures.md) for the full fixture list.

## Running in production

The app builds to a static bundle in `dist/`, plus a tiny Node server for production (`server.mjs`, zero dependencies):

```shell
npm ci
npm run build
MUSIC_DIR=/absolute/path/to/music PORT=8080 node server.mjs   # or: npm start
```

`server.mjs` does three things:

1. Serves `dist/` (content-hashed assets are cached immutably; HTML is not).
2. Serves `MUSIC_DIR` at `/music/*` with HTTP Range support (required for seeking).
3. Forwards the two CORS-hostile upstreams the app needs, to **fixed origins only** — it is not an open proxy:

| Path               | Forwarded to                            | Used for                                            |
| ------------------ | --------------------------------------- | --------------------------------------------------- |
| `/youtubei/v1/*`   | `https://www.youtube.com/youtubei/v1/*` | InnerTube search/player — the YouTube ID resolver   |
| `/translate-proxy/*` | `https://translate.googleapis.com/*`  | Google Translate — translations and romanization    |

Environment variables: `PORT` (default `8080`), `HOST` (default `0.0.0.0`), `MUSIC_DIR` (default `./music`), and `YOUTUBEI_TARGET` / `TRANSLATE_TARGET` (upstream overrides, mainly for testing/staging).

### Why the proxy exists

InnerTube and `translate.googleapis.com` do not send CORS headers, so a browser app cannot call them directly. The Vite dev server proxies them via `server.proxy` in [vite.config.ts](vite.config.ts); `server.mjs` mirrors that behavior for production. **Everything else works without the proxy.** Without network access (or without `server.mjs`), local files, playback, local sidecar/embedded lyrics and theming all work offline; the built-in remote lyric providers simply have no route to their backends.

### YouTube ID resolution — privacy note

Some built-in sources (Unison, YouTube Captions, Spicy Lyrics, …) need the track's **YouTube video ID**. Better Lyrics can resolve it for local files via a three-step ladder:

1. **Embedded tags / URLs** — scanned locally in your browser; never leaves your machine.
2. **InnerTube search** — sends the track's **title and artist** to YouTube through the `/youtubei` proxy.
3. **YouTube Data API v3** — only if you paste your own API key into Settings → Language (sent to `googleapis.com` from your browser).

You can turn the whole ladder off in **Settings → Language → "Resolve YouTube IDs for local files"** (default: on). When off, the resolver is fully disabled — no title/artist is ever sent — and playback, local lyrics and metadata-only providers carry on as usual. Nothing is ever written to YouTube. Local files, playback, theming and editing never depend on this toggle.

## How the app finds lyrics

In order of preference on the default path:

1. **Local sidecar/embedded lyrics** — preferred only when they carry per-word/per-syllable timings (richsync). Line-synced local files never displace a remote synced result; they are a last-resort fallback.
2. **Built-in remote providers** — same catalog and default order as the extension (Better Lyrics, Unison, Spicy Lyrics, BiniLyrics, Musixmatch, LRCLib, YouTube, …). Most remote sources match on the YouTube video ID (see the resolver above); purely metadata-driven sources work without one. Unison-dependent sources are inert until an ID resolves and say so in the UI.
3. If everything fails, the app says so — it never invents lyrics.

You can reorder/disable providers and switch sources per track from the in-player source cycler (dock).

## Settings

Settings live at `/settings.html` and apply live (an open player picks up changes immediately):

| Section   | What's in it                                                                                  |
| --------- | --------------------------------------------------------------------------------------------- |
| Theme     | Built-in themes (Default, HDR) + link to the [theme editor](/editor.html)                    |
| Language  | Interface language (auto + 24 locales), YouTube ID resolution toggle + disclosure, Data API key |
| Lyrics    | Highlight granularity (`auto` / `syllable` / `word` / `line`), hide instrumental-only tracks  |
| Dock      | Controls dock on/off, position (6 positions), auto-hide in fullscreen                          |
| Offsets   | Global lyric offset + synced-lyrics / line-synced trims (±10 s), one-click reset              |
| Advanced  | Debug logging                                                                                  |

Interface translations are contributed via [Crowdin](https://crowdin.com/project/better-lyrics); the web UI ships in 24 locales.

## Demo mode

`?demo=<fixture-id>` boots the player with a synthetic track whose lyrics are a known fixture — useful for development and bug reports.

```shell
npm run dev
# http://localhost:5173/?demo=apple-nested
```

Fixture list and format notes: [docs/demo-fixtures.md](docs/demo-fixtures.md). Demo tracks stream from `music/` like any other local track.

## Privacy

Local library, playback, editing and theming never leave your machine. When the app fetches **remote** lyrics it sends song metadata (title, artist, album, and YouTube ID when known) to the provider backends — see the [privacy note](#running-in-production) for the YouTube ID resolver specifically. No analytics or telemetry are collected by the web build; API request logs on the Better Lyrics backend are kept for a maximum of 7 days (see [PRIVACY.md](PRIVACY.md)).

## FAQ

### Do I need to be online?

No. Local files, playback, sidecar/embedded lyrics, theming and the settings page all work offline. Remote lyric providers, translations and the YouTube ID resolver need network access (and the production proxy for InnerTube/Google Translate).

### Why does Unison show "needs YouTube ID" (or no results)?

Unison (and YouTube Captions / Spicy Lyrics) match on your track's YouTube video ID. Enable the resolver in Settings → Language (or paste a Data API key there) — or accept that those sources stay inert and rely on metadata-only sources and your local files.

### Can I use the marketplace / Unison submission pages?

Not in this build — those extension surfaces are deliberately deferred. See [STANDALONE-WEB-PLAN.md](STANDALONE-WEB-PLAN.md) for scope and rationale.

### Do remote lyric providers work without a YouTube ID?

Some do — anything that matches on title/artist metadata alone. In the default order the YouTube-ID-dependent sources are simply skipped when no ID resolves.

### How do I report a bug?

[Open an issue](https://github.com/better-lyrics/better-lyrics/issues/new/choose) with the output of `npm run selfcheck` attached, or join our [Discord](https://discord.gg/UsHE3d5fWF).

## Development

| Command                | What it does                                             |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | Vite dev server on :5173 (+ `/music` static handler)     |
| `npm run build`        | Production build to `dist/`                              |
| `npm run preview`      | `vite preview` on :4173 with the `/music` handler        |
| `npm start`            | Production server (`server.mjs`) serving `dist/` + proxy |
| `npm run library`      | Build `public/library.json` from `./music`               |
| `npm run typecheck`    | `tsc --noEmit`                                           |
| `npm run selfcheck`    | Module self-checks (43 suites)                           |
| `npm run knip`         | Unused code/exports check                                |
| `npm run lint`         | Biome lint + format (write mode)                         |
| `npm run check:i18n-brand` | Brand-term guard across 24 locales                    |

Layout: `src/app` (player shell), `src/modules/library` (scan/import/resolve), `src/modules/lyrics` (provider pipeline), `src/modules/karaoke` + `src/modules/ui` (renderer host, dock, offsets), `src/modules/settings` (shared settings plumbing), `settings.html` / `editor.html` (MPA pages), `tooling/` (library builder, checks, music static handler), `tests` live next to the code as `*.selfcheck.ts`. The working plan and detailed design notes live in [STANDALONE-WEB-PLAN.md](STANDALONE-WEB-PLAN.md); agent-facing conventions live in [AGENTS.md](AGENTS.md).

## Theming

Custom styling for lyrics is available from Better Lyrics v1.7.0 onwards. The web build ships the built-in Default and HDR themes and a full built-in [RICS editor](/editor.html) with live preview — see the [Styling Guide](./STYLING.md) for syntax, or the [AI agent theme-creation guide](./STYLING-SKILL.md). Both are also on the docs site ([theming](https://docs.betterlyrics.org/theming), [agents](https://docs.betterlyrics.org/theming/agents)).

## Funding

Better Lyrics is free and open-source. The project's backends (lyrics stream, Unison) are self-hosted by contributors; your support helps cover those costs.

<a href="https://www.buymeacoffee.com/boidu" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="42" /></a>

[![Github Sponsors](https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4%EF%B8%8F&logo=GitHub&color=%23F20C33)](https://github.com/sponsors/boidushya)

## Discord Community

<https://discord.gg/UsHE3d5fWF>

## Contributing

Contributions are welcome! Open an issue or a pull request. See the [Contributing Guide](CONTRIBUTING.md) for code and translation contributions, and [STANDALONE-WEB-PLAN.md](STANDALONE-WEB-PLAN.md) for the web port's scope and milestone history.

<a href="https://crowdin.com/project/better-lyrics?utm_source=badge&utm_medium=referral&utm_campaign=badge-add-on">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://badges.crowdin.net/badge/light/crowdin-on-dark@2x.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://badges.crowdin.net/badge/dark/crowdin-on-light@2x.png" />
    <img alt="Crowdin" src="https://badges.crowdin.net/badge/dark/crowdin-on-light@2x.png" width="140" height="40" />
  </picture>
</a>

## License

This project is licensed under the [GNU GPLv3 License](LICENSE). Attribution to [Better Lyrics](https://betterlyrics.org) and contributors is required as per the license terms.

## Privacy Policy

We build privacy-conscious software. The web build's data flow is summarized in the [Privacy section](#privacy) above; [PRIVACY.md](PRIVACY.md) holds the full policy (written for the extension, which shares this project's backends) — including the 7-day API log retention and what third-party processors are involved.

## Trademarks

YouTube Music™, YouTube™, Google™, and Chrome™ are trademarks of Google LLC. Musixmatch® is a trademark of Musixmatch S.p.A. Use of these trademarks is subject to their respective owners' guidelines.

## Contributors ✨

Thanks goes to these wonderful people ([emoji key](https://allcontributors.org/docs/en/emoji-key)):

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ZeDarkAdam"><img src="https://avatars.githubusercontent.com/u/80891624?v=4?s=100" width="100px;" alt="Oleh"/><br /><sub><b>Oleh</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=ZeDarkAdam" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://vinay-portfolioo.netlify.app/"><img src="https://avatars.githubusercontent.com/u/92705023?v=4?s=100" width="100px;" alt="VINAY CHAURASIYA"/><br /><sub><b>VINAY CHAURASIYA</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=VinayChaurasiyaA" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Myse1f"><img src="https://avatars.githubusercontent.com/u/28757057?v=4?s=100" width="100px;" alt="Yvon"/><br /><sub><b>Yvon</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=Myse1f" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/nitinmano"><img src="https://avatars.githubusercontent.com/u/55648552?v=4?s=100" width="100px;" alt="NMPro"/><br /><sub><b>NMPro</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=nitinmano" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/adaliea"><img src="https://avatars.githubusercontent.com/u/59785640?v=4?s=100" width="100px;" alt="Adalie Ahuja"/><br /><sub><b>Adalie Ahuja</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=adaliea" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Kiroolos"><img src="https://avatars.githubusercontent.com/u/43939903?v=4?s=100" width="100px;" alt="Kirolos ☃️"/><br /><sub><b>Kirolos ☃️</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=Kiroolos" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/cschot"><img src="https://avatars.githubusercontent.com/u/40297097?v=4?s=100" width="100px;" alt="cschot"/><br /><sub><b>cschot</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=cschot" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://gustavostz.com/"><img src="https://avatars.githubusercontent.com/u/48111506?v=4?s=100" width="100px;" alt="Gustavo Steinmetz"/><br /><sub><b>Gustavo Steinmetz</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=gustavostz" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://aircraft192.de/"><img src="https://avatars.githubusercontent.com/u/92523442?v=4?s=100" width="100px;" alt="Aircraft192"/><br /><sub><b>Aircraft192</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=Aircraft192" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ramansg"><img src="https://avatars.githubusercontent.com/u/19746632?v=4?s=100" width="100px;" alt="ramansg"/><br /><sub><b>ramansg</b></sub></a><br /><a href="#plugin-ramansg" title="Plugin/utility libraries">🔌</a> <a href="https://github.com/better-lyrics/better-lyrics/commits?author=ramansg" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/The-Developer-Nate"><img src="https://avatars.githubusercontent.com/u/67196220?v=4?s=100" width="100px;" alt="TheDevNate"/><br /><sub><b>TheDevNate</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=The-Developer-Nate" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://github.com/mukeenanyafiq"><img src="https://avatars.githubusercontent.com/u/93072673?v=4?s=100" width="100px;" alt="Keenan Yafiq"/><br /><sub><b>Keenan Yafiq</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=mukeenanyafiq" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/SashaGonch228"><img src="https://avatars.githubusercontent.com/u/78559764?v=4?s=100" width="100px;" alt="SashaGonch228"/><br /><sub><b>SashaGonch228</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=SashaGonch228" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/chengggit"><img src="https://avatars.githubusercontent.com/u/118322222?v=4?s=100" width="100px;" alt="chengg"/><br /><sub><b>chengg</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=chengggit" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ShuiGuiPoppy"><img src="https://avatars.githubusercontent.com/u/219837672?v=4?s=100" width="100px;" alt="ShuiGuiPoppy"/><br /><sub><b>ShuiGuiPoppy</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=ShuiGuiPoppy" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://ibratabian17.github.io"><img src="https://avatars.githubusercontent.com/u/71920907?v=4?s=100" width="100px;" alt="Ibra Al Tabian"/><br /><sub><b>Ibra Al Tabian</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=ibratabian17" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://binimum.org"><img src="https://avatars.githubusercontent.com/u/61615730?v=4?s=100" width="100px;" alt="binimum"/><br /><sub><b>binimum</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=binimum" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/noobpro45"><img src="https://avatars.githubusercontent.com/u/137317223?v=4?s=100" width="100px;" alt="Michael"/><br /><sub><b>Michael</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=noobpro45" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/MeDustyy"><img src="https://avatars.githubusercontent.com/u/58863601?v=4?s=100" width="100px;" alt="Oleksandr"/><br /><sub><b>Oleksandr</b></sub></a><br /><a href="#ideas-MeDustyy" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/llc1123"><img src="https://avatars.githubusercontent.com/u/5478730?v=4?s=100" width="100px;" alt="粒粒橙"/><br /><sub><b>粒粒橙</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=llc1123" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://portfolio-website-liart-nu-45.vercel.app/"><img src="https://avatars.githubusercontent.com/u/152849669?v=4?s=100" width="100px;" alt="Aditya Sai prem"/><br /><sub><b>Aditya Sai prem</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=Adityuhh11" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/snowyukitty"><img src="https://avatars.githubusercontent.com/u/270071858?v=4?s=100" width="100px;" alt="snowyukitty"/><br /><sub><b>snowyukitty</b></sub></a><br /><a href="https://github.com/better-lyrics/better-lyrics/commits?author=snowyukitty" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tommyorwhat"><img src="https://avatars.githubusercontent.com/u/111241986?v=4?s=100" width="100px;" alt="Tommy"/><br /><sub><b>Tommy</b></sub></a><br /><a href="#design-tommyorwhat" title="Design">🎨</a> <a href="https://github.com/better-lyrics/better-lyrics/commits?author=tommyorwhat" title="Code">💻</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!
