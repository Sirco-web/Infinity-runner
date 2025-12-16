# Infinity Runner

A Node.js server that continuously computes Fibonacci sequence numbers and displays them in real-time on a web interface. The server saves progress to a GitHub repository every 45 numbers and can resume from where it left off after restarts.

## Features

- 🔢 **Continuous Computation**: Computes Fibonacci sequence numbers continuously
- 📊 **Live Web Interface**: Real-time display of computation progress via WebSocket
- 💾 **GitHub Persistence**: Saves progress every 45 numbers to a GitHub repository
- 🔄 **Auto-Resume**: Automatically resumes from the last saved position on restart
- 📈 **Statistics Dashboard**: Shows current number, total count, and next save point
- 🎨 **Beautiful UI**: Modern gradient design with real-time animations

## Prerequisites

- Node.js (v14 or higher)
- A GitHub account
- A GitHub Personal Access Token with `repo` permissions

## Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/Sirco-web/Infinity-runner.git
   cd Infinity-runner
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create a GitHub repository for data storage**
   - Create a new GitHub repository (e.g., `infinity-runner-data`)
   - This will store the computation progress

4. **Set up environment variables**
   - Copy `.env.example` to `.env`
   ```bash
   cp .env.example .env
   ```
   - Edit `.env` and add your configuration:
     - `GITHUB_TOKEN`: Your GitHub Personal Access Token
     - `GITHUB_OWNER`: Your GitHub username or organization
     - `GITHUB_REPO`: The name of your data repository
     - `PORT`: Server port (optional, defaults to 3000)

5. **Generate a GitHub Personal Access Token**
   - Go to GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)
   - Click "Generate new token (classic)"
   - Give it a name (e.g., "Infinity Runner")
   - Select the `repo` scope
   - Generate and copy the token to your `.env` file

## Usage

**Start the server**
```bash
npm start
```

**Access the web interface**
Open your browser and navigate to:
```
http://localhost:3000
```

**Stop the server**
Press `Ctrl+C` in the terminal. The server will gracefully save the current progress to GitHub before shutting down.

## How It Works

1. **Computation**: The server computes Fibonacci numbers using BigInt to handle arbitrarily large numbers
2. **Live Updates**: Each computed number is broadcast to all connected web clients via WebSocket
3. **Persistence**: Every 45 numbers, the server saves the latest 45 numbers to the GitHub repository's README
4. **Resume**: On startup, the server checks the GitHub repository and resumes from the last saved state
5. **Graceful Shutdown**: When stopped (SIGINT/SIGTERM), the server saves current progress before exiting

## Project Structure

```
Infinity-runner/
├── server.js           # Main server application
├── public/
│   └── index.html     # Web interface
├── package.json       # Node.js dependencies and scripts
├── .env.example       # Environment variables template
├── .gitignore         # Git ignore file
└── README.md          # This file
```

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `GITHUB_TOKEN` | GitHub Personal Access Token | Yes | - |
| `GITHUB_OWNER` | GitHub username or organization | No | `Sirco-web` |
| `GITHUB_REPO` | Repository name for data storage | No | `infinity-runner-data` |
| `PORT` | Server port number | No | `3000` |

## Technical Details

- **Equation**: Fibonacci sequence (F(n) = F(n-1) + F(n-2))
- **Interval**: Computes a new number every 100ms
- **Save Frequency**: Every 45 numbers
- **Number Storage**: Uses BigInt for unlimited precision
- **Web Framework**: Express.js
- **Real-time Communication**: WebSocket (ws library)
- **GitHub API**: Octokit

## License

ISC