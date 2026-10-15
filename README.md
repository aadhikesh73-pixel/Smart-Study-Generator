# Smart Study

A local-first study workspace. Attach notes (or paste text), pick a study mode, and a model running on your own machine through [Ollama](https://ollama.com) produces summaries, flashcards, quizzes, exam prep, plain-language explanations and organized study notes.

Built with plain HTML5, CSS3 and vanilla JavaScript (ES modules). No framework, no build step, no custom backend, no API keys. Nothing is sent to a third-party service.

## Quick start

1. **Install Ollama** and pull the default model:
   ```bash
   ollama pull qwen3:4b
   ```
2. **Serve this folder** with any static file server. ES modules do not load from `file://`.
   ```bash
   cd SmartStudyGenerator
   python3 -m http.server 8080      # or: npx serve -l 8080   or the VS Code "Live Server" extension
   ```
3. Open <http://localhost:8080>. The pill in the top bar shows whether Ollama is reachable and the model is installed.

## Verify Ollama

```bash
ollama list                              # qwen3:4b should be listed
curl http://localhost:11434/api/tags     # returns JSON when the server is up
```
In the app: **Settings → Test connection**. It reports unreachable server, missing model, or success (and lists installed models in the Model field's suggestions).

## Choose another model or endpoint

**Settings → Ollama connection.** Change the model (for example `llama3.2:3b`) and/or the endpoint (default `http://localhost:11434/api/chat`). Changes save immediately and the connection is re-checked.

## Fixing CORS errors safely

Ollama accepts requests from localhost origins by default, so serving the app from `http://localhost:<port>` should just work. If you see "Can't reach Ollama" while `ollama list` works, the page's origin is probably not allowed (different hostname, LAN IP, or `file://`). Allow **only the origin you use**, not `*`:

| System | How |
|---|---|
| Terminal | `OLLAMA_ORIGINS=http://localhost:8080 ollama serve` |
| macOS app | `launchctl setenv OLLAMA_ORIGINS "http://localhost:8080"`, then quit and reopen Ollama |
| Linux (systemd) | `sudo systemctl edit ollama.service`, add `Environment="OLLAMA_ORIGINS=http://localhost:8080"`, then `sudo systemctl restart ollama` |
| Windows | Set a user environment variable `OLLAMA_ORIGINS`, then quit and reopen Ollama |

Keep Ollama bound to `127.0.0.1` (the default) unless you deliberately want other devices to use it.

## Features

- **Modes:** Summary, Flashcards (flip, previous/next, known / needs revision, review-only view), Quiz (multiple choice, instant feedback, score, review of misses, retake), Exam prep, Explain (follow-ups in the same chat), Study notes, and free Ask.
- **Options:** subject, difficulty and length per message.
- **Files:** `.txt .md .pdf .csv .json`, drag and drop or the paperclip, up to 10 files of 10 MB each (configurable), per-file status and progress, duplicate detection, extracted-text preview, clear errors.
- **Chat:** streaming with a thinking animation, stop button, copy / regenerate / delete, smart auto-scroll with "Jump to latest", Markdown rendering with copyable code blocks.
- **History:** grouped by Today / Yesterday / Previous 7 days / Older, pinning, renaming (double-click or menu), subjects, search over titles and message text, delete with confirmation, JSON export and import.
- **Design:** dark and light themes (plus system), responsive down to phones with a slide-out sidebar, keyboard focus styles, reduced-motion support.
- **Shortcuts:** `Enter` send, `Shift+Enter` new line, `Ctrl/Cmd+K` search, `Ctrl/Cmd+Shift+O` new chat.

Flashcard and quiz modes ask the model for a strict text format, then turn it into the interactive widgets. If the model ignores the format, you simply get the readable text instead, and "View as text" is always available under a widget. Nothing is fabricated when Ollama is down: you get an error with a retry button.

## Project structure

```
SmartStudyGenerator/
├── index.html              Page shell, dialogs, semantic markup
├── assets/                 icons/favicon.svg, images/ (empty), optional vendor/pdfjs/
├── css/
│   ├── variables.css       Design tokens and the dark/light themes
│   ├── base.css            Reset, typography, focus, scrollbars
│   ├── layout.css          App grid, sidebar, thread, composer dock
│   ├── components.css      Buttons, forms, messages, widgets, dialogs
│   ├── animations.css      Keyframes and reduced-motion handling
│   └── responsive.css      Tablet and phone rules
└── js/
    ├── app.js              Entry point, global events, storage notices
    ├── state.js            Shared state, settings validation, event bus
    ├── storage.js          LocalStorage, quota recovery, export/import
    ├── chat.js             Conversation logic: send, stream, stop, regenerate, subjects
    ├── ollama.js           Ollama client: connection check, streaming, errors, timeouts
    ├── study-generator.js  Prompts, context budgeting, flashcard/quiz parsers, titles
    ├── file-handler.js     File validation and text extraction (PDF.js for PDFs)
    ├── markdown.js         Markdown renderer plus allow-list HTML sanitizer
    ├── study-widgets.js    Interactive flashcards and quiz
    ├── chat-view.js        Message thread rendering and streaming patches
    ├── composer.js         Input, modes, options, attachments, drag and drop
    ├── sidebar.js          History, search, subjects, item menus
    ├── settings.js         Settings dialog
    ├── ui.js               Theme, drawer, toasts, dialogs, popup menus, status pills
    ├── icons.js            Inline SVG icon set
    └── utils.js            Small shared helpers
```
`chat-view.js`, `composer.js`, `sidebar.js`, `settings.js`, `study-widgets.js` and `icons.js` are additions to the minimum file list; they keep `ui.js` and `chat.js` small and single-purpose.

## How local persistence works

Conversations, subjects, settings, pins, titles, flashcard/quiz progress and attached-file text are saved in the browser's **LocalStorage** (keys start with `smartstudy.`), debounced while streaming and flushed when the tab is hidden or closed. On reload the last open chat and the whole list are restored.

- It is **not encrypted** and is readable by anyone who can use this browser profile. Do not keep sensitive documents in it.
- It is local to this browser profile and can be cleared by you or by the browser.
- Limit is typically about 5 MB. Each attached file's text is capped at 100,000 characters when saved. If storage fills up, the app removes stored file text from the oldest chats first and tells you; if that is not enough, it warns that changes are not being saved. Export your chats regularly (Settings → Your data).
- If storage is blocked entirely (some private modes), the app still works but nothing persists.
- IndexedDB would hold much larger files; it is not used in this version.

## Security notes

- User text goes into the DOM with `textContent`. Model output is Markdown-rendered by escaping everything first, then passed through an allow-list sanitizer (only a few tags, only `http(s)`/`mailto` links, no inline handlers, no images). AI output is never executed.
- No analytics, no third-party requests except loading PDF.js from cdnjs the first time you open a PDF (see below).

## PDF support and offline use

PDFs are read with PDF.js, loaded on demand. The app first looks for `assets/vendor/pdfjs/pdf.min.js` and `pdf.worker.min.js` (version 3.11.x), then falls back to cdnjs. To work fully offline, download those two files from the PDF.js 3.11.174 release into `assets/vendor/pdfjs/` (this folder is git-ignored).

## Current limitations

- **Scanned PDFs need OCR, which is not included.** Image-only PDFs report "No selectable text found".
- **Small models have small context windows.** Notes longer than the context length (default 8,192 tokens, adjustable in Settings) are shortened to fit and the answer carries a visible notice. Raising the context uses more memory and is slower.
- Output quality depends on the model. Strict formats (flashcards, quiz) can occasionally come back malformed; you will then see plain text.
- Thinking models such as `qwen3` can be slow to start; "reason before answering" is off by default for speed.
- One response is generated at a time.
- Verified in Chromium against a simulated Ollama server; test in your own browser and with your real model.
