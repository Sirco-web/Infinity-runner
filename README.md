# Infinity Runner

A Node.js server that continuously computes Fibonacci sequence numbers and displays them in real-time on a modern web interface. The server saves progress to a GitHub repository every 10 minutes and can resume from where it left off after restarts.

## Features

- 🔢 **Continuous Computation**: Computes Fibonacci sequence numbers continuously (10 numbers/second)
- 📊 **Modern Web Interface**: Real-time display with educational content about the Fibonacci sequence
- 💾 **GitHub Persistence**: Saves progress every 10 minutes to avoid rate limiting
- 🔄 **Auto-Resume**: Automatically resumes from the last saved position on restart
- 📈 **Statistics Dashboard**: Shows numbers computed, digits, uptime, and next save countdown
- 🎨 **Beautiful UI**: Modern gradient design with real-time animations
- 💡 **Educational**: Explains how the Fibonacci sequence works and displays server specs
- ☁️ **Cloud-Ready**: Optimized for Render.com free tier (512 MB RAM, 0.1 vCPU)

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

### The Fibonacci Sequence
The Fibonacci sequence is a series of numbers where each number is the sum of the two preceding ones:
- Formula: `F(n) = F(n-1) + F(n-2)`
- Example: 0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89...
- Found in nature (spirals, petals), architecture, and art
- Related to the golden ratio (φ ≈ 1.618)

### Server Operation
1. **Computation**: Uses BigInt for unlimited precision, computes a new number every 100ms
2. **Live Updates**: WebSocket broadcasts each number to all connected clients instantly
3. **Persistence**: Every 10 minutes, saves latest 45 numbers to GitHub repository's README
4. **Resume**: On startup, checks GitHub repository and continues from last saved state
5. **Graceful Shutdown**: Saves current progress before exiting (SIGINT/SIGTERM)

### Why 10 Minutes?
To avoid GitHub API rate limiting, especially on free-tier hosting platforms like Render.com.

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
- **Computation Rate**: 10 numbers per second (100ms interval)
- **Save Frequency**: Every 10 minutes (to avoid GitHub rate limiting)
- **Number Storage**: Uses BigInt for unlimited precision
- **Web Framework**: Express.js
- **Real-time Communication**: WebSocket (ws library)
- **GitHub API**: Octokit (@octokit/rest)
- **Environment Config**: dotenv

## Deployment

### Render.com (Recommended)

This application is optimized for Render.com's free tier:

**Free Tier Specs:**
- RAM: 512 MB
- CPU: 0.1 vCPU
- Perfect for continuous Fibonacci computation

**Deployment Steps:**
1. Fork this repository to your GitHub account
2. Create a new Web Service on Render.com
3. Connect your GitHub repository
4. Set environment variables in Render dashboard:
   - `GITHUB_TOKEN`
   - `GITHUB_OWNER`
   - `GITHUB_REPO`
5. Deploy!

The 10-minute save interval is specifically designed to work well with free hosting tiers and avoid GitHub API rate limits.

## License

ISC