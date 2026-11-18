# CodeBase

An editor for building websites. Write HTML, CSS and JavaScript by hand or with an AI assistant, preview the result on desktop and phone screens, then export a single file or publish it. Runs in the browser or as a desktop app for Windows, Mac and Linux.

## Getting started

Requires Node 18 or later. There are no runtime dependencies.

```bash
npm start
```

Open http://localhost:3000. Projects are saved in the browser, and in your account if you sign in.

| Variable               | Default              | Purpose                                                                       |
| ---------------------- | -------------------- | ----------------------------------------------------------------------------- |
| `PORT`                 | `3000`               | Port to listen on                                                             |
| `DATA_DIR`             | `./data`             | Where accounts, saved projects and published sites are stored                 |
| `ACCOUNTS`             | on                   | Set to `false` to turn accounts off                                           |
| `REQUIRE_ACCOUNT`      | off                  | Only signed-in users can use the AI proxy and publish. Use on a public server |
| `ALLOW_SIGNUP`         | on                   | Set to `false` to stop new sign-ups, e.g. once your own account exists        |
| `DESKTOP_DOWNLOAD_URL` | this repo's releases | Where the "Get the desktop app" link points                                   |

## Features

- **Editor:** multiple files and folders, tabs, uploads, syntax highlighting.
- **Preview:** live reload, a console that captures logs and errors, and device frames for laptop, Windows, Mac, iPhone and Android, with rotation for phones.
- **Assistant:** four modes.
  - **Build** creates and edits files, with undo.
  - **Fix** makes minimal changes and reads the preview's console errors.
  - **Review** leaves comments on specific lines without changing code.
  - **Ask** answers questions about the project.
- **Inline suggestions:** completions appear as you type. Press Tab to accept or Esc to dismiss.
- **Export:** download the site as one self-contained HTML file with styles, scripts and images inlined.
- **Publish:** host the project at `/s/<name>/` on the same server.
- **Accounts:** sign up with an email and password to keep projects in your account and open them on any device. Changes sync automatically. Sites published while signed in belong to your account.
- **Desktop app:** the whole editor as an app for Windows, Mac and Linux. It works offline, or can connect to a CodeBase server to use your account and publish.
- **Styles:** Classic, Flow and Paper, each with a light and a dark version.

## AI models

Pick a model from the assistant panel. There are three kinds:

1. **On-device (free).** Qwen2.5-Coder in 0.5B, 1.5B or 3B sizes, run in the browser with [WebLLM](https://github.com/mlc-ai/web-llm). The model downloads once (about 300 MB, 900 MB or 1.7 GB) and then works offline. Requires WebGPU: Chrome or Edge on desktop, or a recent Safari. Small models are much less capable than hosted ones and only see about 14,000 characters of the project at a time, starting with the open file.
2. **Your own.** Anthropic, OpenAI, Gemini, OpenRouter, Ollama, LM Studio, or any OpenAI-compatible endpoint. Paste a key and CodeBase lists the models it can use. Keys are stored in the browser, never in your account, and forwarded to the provider by the server.
3. **Server-provided (optional).** The operator can offer a hosted model to every visitor.

Inline suggestions can use a different model from the chat, for example a cheaper one.

### Connecting Claude

Open **AI models → Connect Claude**, paste an API key from the [Claude Console](https://platform.claude.com/settings/keys), and choose which models to add (Opus, Sonnet and Haiku are selected by default). Opus becomes the chat model and Haiku handles inline suggestions. Usage is billed to your Console account.

A Claude Pro or Max subscription can't be used to sign in: Anthropic doesn't allow third-party apps to use claude.ai logins, only its own apps such as Claude Code.

### Offering a server-provided model

| Variable                  | Description                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| `BUILTIN_AI_URL`          | API base URL, e.g. `https://api.openai.com/v1`                    |
| `BUILTIN_AI_MODEL`        | Model ID                                                          |
| `BUILTIN_AI_KEY`          | API key, kept on the server                                       |
| `BUILTIN_AI_PROVIDER`     | `anthropic` for the Anthropic API; omit for OpenAI-compatible     |
| `BUILTIN_AI_NAME`         | Name shown in the model picker                                    |
| `BUILTIN_AI_HOURLY_LIMIT` | Requests per visitor per hour (default 200, includes suggestions) |

Requests are billed to the operator's account.

## Desktop app

Download it from the [releases page](https://github.com/eltschu/codebase/releases/latest):

| System  | File                                                                     |
| ------- | ------------------------------------------------------------------------ |
| Windows | `CodeBase-<version>-win-x64.exe`                                         |
| Mac     | `CodeBase-<version>-mac-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel) |
| Linux   | `CodeBase-<version>-linux-x86_64.AppImage`                               |

The installers aren't code-signed yet, so the first launch shows a warning:

- **Windows:** "Windows protected your PC" → **More info → Run anyway**.
- **Mac:** if macOS says the app is damaged or can't be opened, drag it to Applications, then run `xattr -cr /Applications/CodeBase.app` in Terminal and open it again.
- **Linux:** make the AppImage executable (`chmod +x`) and run it.

The app runs its own copy of the server on `127.0.0.1`, so everything works offline and projects stay on that computer. **File → Connect to a server** switches it to a hosted CodeBase so you can sign in and publish.

To make a release, bump `version` in `package.json` and push a tag such as `v0.5.0`. The [Desktop app workflow](.github/workflows/desktop.yml) builds all three installers and attaches them to a GitHub release.

## Hosting

Any host that runs Node works. On [Render](https://render.com): create a **Web Service** from this repository with build command `npm ci --omit=dev` and start command `npm start`.

- Set `REQUIRE_ACCOUNT=true` before sharing the address, so strangers can't use the server to relay AI requests.
- Accounts, saved projects and published sites live in `DATA_DIR`. Free plans on most hosts wipe the disk on every restart or deploy, which deletes them. Attach a persistent disk (on Render, a paid plan) and point `DATA_DIR` at it.
- Serve it over HTTPS (Render does this for you) so sign-in cookies are sent securely.

## Limitations

- Device frames match screen size and user agent, but pages render in your own browser's engine, not real iOS, Android or Windows.
- Previews and published sites run in a sandbox so they can't read the editor's data. `localStorage` inside them is in-memory and resets on reload.
- Projects are static sites. There is no server-side code or build step.
- `/api/ai` forwards requests to any URL the client provides. On a public server, set `REQUIRE_ACCOUNT=true` and consider `ALLOW_SIGNUP=false`.
- Accounts use email and password only. There is no password reset or email verification yet.
- Data is stored as JSON files, which suits one server and a modest number of users, not a large service.

## Development

```bash
npm install       # installs Prettier
npm test          # server tests
npm run format    # format the codebase
npm run dev       # restart on changes
npm run desktop   # run the desktop app from source
npm run desktop:build   # build installers for this system into dist/
```

```
server.js              HTTP server: static files, previews, publishing, AI proxy, accounts
lib/accounts.js        accounts, sessions and saved projects
desktop/               Electron app: starts the server and opens the editor in a window
build/                 desktop app icon
public/
  index.html           page structure and icon set
  app.js               editor, preview, export, publishing and assistant
  llm-worker.js        runs on-device models off the main thread
  styles/
    base.css           layout and components (Flow style)
    devices.css        device frames
    classic.css        Classic style
    paper.css          Paper style
  vendor/codemirror/   CodeMirror 5 (MIT)
test/                  server tests (node:test)
.github/workflows/     tests on every push; desktop builds on version tags
```
