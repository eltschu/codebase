# CodeBase

A browser-based editor for building websites. Write HTML, CSS and JavaScript by hand or with an AI assistant, preview the result on desktop and phone screens, then export a single file or publish it.

## Getting started

Requires Node 18 or later. There are no runtime dependencies.

```bash
npm start
```

Open http://localhost:3000. Projects are saved in the browser.

| Variable   | Default  | Purpose                                  |
| ---------- | -------- | ---------------------------------------- |
| `PORT`     | `3000`   | Port to listen on                        |
| `DATA_DIR` | `./data` | Where published sites are stored on disk |

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
- **Styles:** Classic, Flow and Paper, each with a light and a dark version.

## AI models

Pick a model from the assistant panel. There are three kinds:

1. **On-device (free).** Qwen2.5-Coder in 0.5B, 1.5B or 3B sizes, run in the browser with [WebLLM](https://github.com/mlc-ai/web-llm). The model downloads once (about 300 MB, 900 MB or 1.7 GB) and then works offline. Requires WebGPU: Chrome or Edge on desktop, or a recent Safari. Small models are much less capable than hosted ones and only see about 14,000 characters of the project at a time, starting with the open file.
2. **Your own.** Anthropic, OpenAI, Gemini, OpenRouter, Ollama, LM Studio, or any OpenAI-compatible endpoint. Keys are stored in the browser and forwarded to the provider by the server.
3. **Server-provided (optional).** The operator can offer a hosted model to every visitor.

Inline suggestions can use a different model from the chat, for example a cheaper one.

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

## Limitations

- Device frames match screen size and user agent, but pages render in your own browser's engine, not real iOS, Android or Windows.
- Previews and published sites run in a sandbox so they can't read the editor's data. `localStorage` inside them is in-memory and resets on reload.
- Projects are static sites. There is no server-side code or build step.
- There are no user accounts, and `/api/ai` forwards requests to any URL the client provides. Put the server behind authentication before exposing it publicly.

## Development

```bash
npm install       # installs Prettier
npm test          # server tests
npm run format    # format the codebase
npm run dev       # restart on changes
```

```
server.js              HTTP server: static files, previews, publishing, AI proxy
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
```
