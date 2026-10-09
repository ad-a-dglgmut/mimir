# Mimir

Mimir is a desktop data analysis app. Load a CSV or Excel file, ask questions in plain English, and get back a written summary, a chart, suggested follow-up questions, and expert-style recommendations.

Built with **Tauri v2** (Rust), a **React + TypeScript** frontend, and a bundled **Python** analysis engine powered by an LLM through the Groq API.

## Features

- **Natural-language analysis.** Ask a question about your data. Mimir generates pandas code, runs it, and explains the result in plain text.
- **Charts.** Results are turned into interactive ECharts visualizations (bar and line), with zoom and pan.
- **Chart export.** Download charts as PNG or SVG, or export the underlying data as CSV.
- **Follow-up suggestions.** Each answer comes with three suggested next questions.
- **Mimir Recommends.** Each answer includes recommendations with a predicted outcome and the cost of taking no action, each with its reasoning.
- **CSV and Excel support.** `.csv`, `.xls` and `.xlsx` files; Excel files are converted to CSV on import. Drag and drop or use the file picker.
- **Multi-file merge.** Upload several files and merge them on a shared column (inner, left, right or full outer join).
- **Chat sessions.** Separate sessions, each with its own dataset and history, saved to disk and restored on launch.
- **Accounts.** Login with "remember me", automatic re-login through refresh tokens, and password reset by email.
- **Auto-updates.** The app checks for new releases and installs them in place.
- **Light and dark themes.**

## How it works

```
React UI  --invoke-->  Rust (Tauri commands)  --stdin/stdout JSON-->  Python analyzer  -->  Groq API
```

1. The React frontend calls Tauri commands such as `analyze_query`.
2. The Rust backend fetches a Groq API key from the Mimir API using the user's JWT. The key is never stored in the app.
3. Rust starts `analyzer.py` once and keeps it running. It sends each request as one line of JSON over stdin and waits for a response wrapped in `===RESULT_START===` and `===RESULT_END===` markers.
4. The Python process loads and cleans the dataset, asks the LLM for pandas code, executes it, then generates the summary, chart JSON, follow-up prompts and recommendations.
5. Rust parses the response, stores it in the chat history, saves it to disk, and returns it to the UI.

## Project structure

```
.
├── src/                          # React frontend (App.tsx, components, assets)
├── src-tauri/
│   ├── src/main.rs               # Tauri commands: auth, chats, files, merge, Python bridge
│   ├── python/
│   │   ├── analyzer.py           # Analysis engine (runs as a long-lived process)
│   │   ├── create-venvs.sh       # Builds the Linux Python venv
│   │   └── create-windows-python.ps1  # Builds the bundled Windows Python
│   └── tauri.conf.json
├── scripts/
│   ├── sign-windows.ps1          # Code signing helper (jsign + Google Cloud KMS)
│   └── upload-update.js          # Uploads release artifacts for the updater (S3)
└── .github/workflows/release.yml # Build, sign and release pipeline
```

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (stable)
- Tauri system dependencies for your OS: see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- Python 3 (used to build the bundled environment)
- A Mimir account for the login screen and API key

### Setup

```bash
# 1. Install frontend dependencies
npm install

# 2. Build the Python environment used by the app
chmod +x src-tauri/python/create-venvs.sh
./src-tauri/python/create-venvs.sh

# 3. Run the app in development mode
npm run tauri dev
```

In development, `main.rs` looks for the interpreter at `src-tauri/python/linux-venv/bin/python`. On Windows or macOS, adjust the dev path in `get_python_paths` or create a matching venv.

### Configuration

| Setting | Where | Purpose |
|---|---|---|
| `GROQ_MODEL` | environment variable | Overrides the LLM model name used by `analyzer.py`. The default is set at the top of the file. |
| `API_BASE_URL` | `src-tauri/src/main.rs` | Base URL of the Mimir API (login, refresh, API key). |

The Groq API key comes from the Mimir API at request time, so no local key is needed.

### Building

```bash
npm run build
npx tauri build
```

## Releasing

Releases are built by GitHub Actions when you push a tag that starts with `v`:

```bash
git tag v1.2.6
git push origin v1.2.6
```

The workflow:

1. Sets the version in `tauri.conf.json` and `Cargo.toml` from the tag.
2. Builds a Linux AppImage and a Windows MSI, each with a bundled Python runtime.
3. On Windows, signs the bundled Python binaries, the app executable and the MSI through `scripts/sign-windows.ps1` (jsign with a key in Google Cloud KMS), then verifies that everything inside the installer is signed.
4. Generates the updater signature and uploads the artifacts to S3 for the in-app updater.

### Required repository secrets

| Secret | Used for |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Signing updater artifacts |
| `GCP_KMS_SERVICE_ACCOUNT_KEY` | Authenticating to Google Cloud KMS |
| `GCP_KMS_KEY_PATH` | Path of the KMS code signing key |
| `SECTIGO_CERT_BASE64` | Code signing certificate chain (leaf plus intermediates), base64-encoded |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Uploading update artifacts to S3 |

## Data storage

Everything is stored in the app data directory for your OS:

| Item | Location |
|---|---|
| Chat history and dataset path | `<app data>/<chat name>.json` |
| Saved login (refresh token) | `<app data>/logininfo.json` |
| Uploaded files | `<app data>/uploads/` |
| Excel files converted to CSV | `<app data>/csv_conversions/` |
| Merged datasets | `<app data>/merged_files/` |

## Troubleshooting

- **"Failed to generate code" in the UI.** The LLM request failed. The message now includes the reason, and details are printed to the terminal when you run `npm run tauri dev`. Common causes are a deprecated model name (set `GROQ_MODEL`), an invalid API key, or rate limits.
- **Python changes have no effect.** The analyzer is started once and reused. Stop and restart the whole app. Also check that you edited the `analyzer.py` that is actually being run.
- **Summaries show up as tables.** `analyzer.py` strips markdown from summaries. If tables still appear, an older copy of the script is running.
- **Windows or the browser flags the installer as a virus.** Make sure the build passed the "Verify signatures" step. New or low-traffic download domains can also trigger browser reputation checks that signing alone doesn't clear; serving downloads from your own domain helps.

## Known limitations

- LLM-generated pandas code is executed with a restricted set of builtins. This is not a security sandbox, so only analyze data you trust.
- The refresh token is stored unencrypted in `logininfo.json`. Consider moving it to the OS keychain.
- The dev setup assumes a Linux venv path (see Getting started).

## License

TBD
