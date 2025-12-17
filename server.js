const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { Octokit } = require('@octokit/rest');
require('dotenv').config({ override: true });

const app = express();
const port = process.env.PORT || 3000;

// Use GH_PAT to avoid Codespaces overriding GITHUB_TOKEN
const GITHUB_TOKEN = process.env.GH_PAT || process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.GITHUB_REPO;
const OWNER_PIN = process.env.OWNER_PIN;

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
    console.error('Error: GH_PAT (or GITHUB_TOKEN), GITHUB_OWNER, and GITHUB_REPO must be defined in .env');
    process.exit(1);
}

// Serve static files
app.use(express.static('public'));
app.use(express.json()); // For parsing application/json

const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// WebSocket setup
const wss = new WebSocketServer({ server });

// GitHub setup
const octokit = new Octokit({
  auth: GITHUB_TOKEN
});

const README_PATH = 'README.md';
const ALL_NUMBERS_PATH = 'all.json';
const CHUNK_SIZE = 50000; // Numbers per chunk file
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB GitHub limit

// State management
let currentNumbers = [];
let allNumbers = []; // Store ALL computed numbers
let allNumbersNeedsFetch = false; // Flag to indicate we need to fetch existing data before saving
let count = 0;
let a = 0n; // Using BigInt for large Fibonacci numbers
let b = 1n;
let isSaving = false; // Flag to track if save is in progress
let pendingSave = false; // Flag to track if a save is queued
let saveQueue = []; // Queue for save operations
let isProcessingQueue = false;
let serverStartTime = new Date();
let lastSaveTime = new Date();
let lastCommitTime = 0;
let lastManualSaveTime = 0;
const COMMIT_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MANUAL_SAVE_COOLDOWN = 60 * 1000; // 1 minute

// Server specs (for display on frontend)
const SERVER_SPECS = {
  platform: 'Render.com Free Tier',
  ram: '512 MB',
  cpu: '0.1 vCPU'
};

// Track if GitHub integration is available
let githubAvailable = false;

// Broadcast to all connected clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Check if the repository exists and set githubAvailable flag
async function checkRepositoryExists() {
  try {
    await octokit.repos.get({
      owner: REPO_OWNER,
      repo: REPO_NAME,
    });
    console.log(`✓ Repository ${REPO_OWNER}/${REPO_NAME} found - GitHub saving enabled`);
    githubAvailable = true;
    return true;
  } catch (error) {
    if (error.status === 404) {
      console.log(`⚠ Repository ${REPO_OWNER}/${REPO_NAME} not found`);
      console.log(`  Please create it manually at: https://github.com/new`);
      console.log(`  Repository name: ${REPO_NAME}`);
      console.log(`  GitHub saving disabled until repository is created`);
    } else {
      console.error('Error checking repository:', error.message);
    }
    githubAvailable = false;
    return false;
  }
}

// Load chunked data from multiple files (handles old chunk format)
async function loadChunkedData(indexData) {
  const numChunks = indexData.chunks;
  allNumbers = [];
  let loadedAny = false;
  
  console.log(`Attempting to load ${numChunks} chunk files...`);
  
  for (let i = 0; i < numChunks; i++) {
    // Try different chunk path formats (old and new)
    const chunkPaths = [
      `chunks/chunk_${String(i + 1).padStart(4, '0')}.json`,
      `chunks/chunk_${i}.json`,
      `chunk_${i}.json`
    ];
    
    let loaded = false;
    for (const chunkPath of chunkPaths) {
      try {
        const { data } = await octokit.repos.getContent({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          path: chunkPath,
        });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const chunkData = JSON.parse(content);
        allNumbers.push(...chunkData.numbers);
        console.log(`Loaded chunk ${i + 1}/${numChunks} from ${chunkPath}`);
        loaded = true;
        loadedAny = true;
        break;
      } catch (error) {
        // Try next path format
      }
    }
    
    if (!loaded) {
      console.log(`Chunk ${i + 1} not found in any format, stopping chunk load`);
      break;
    }
  }
  
  // If we couldn't load chunks, fall back to README
  if (!loadedAny) {
    console.log('No chunks could be loaded, will fall back to README');
    allNumbers = [];
    return false;
  }
  
  count = indexData.count || allNumbers.length;
  
  if (allNumbers.length >= 2) {
    const lastTwo = allNumbers.slice(-2);
    a = BigInt(lastTwo[0]);
    b = BigInt(lastTwo[1]);
    currentNumbers = allNumbers.slice(-45);
    console.log(`Loaded ${allNumbers.length} numbers from chunks`);
    console.log(`Resuming from position ${count}`);
    return true;
  }
  
  return false;
}

// Load state from GitHub
async function loadStateFromGitHub() {
  if (!githubAvailable) {
    console.log('GitHub not available, starting fresh');
    return;
  }
  
  // First, try to load all.json for complete history
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: ALL_NUMBERS_PATH,
    });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    
    // Check if data is chunked (old format)
    if (parsed.chunks && !parsed.numbers) {
      console.log(`Found chunked index: ${parsed.chunks} chunks, attempting to load...`);
      const success = await loadChunkedData(parsed);
      if (success) {
        return;
      }
      // If chunk loading failed, fall through to README fallback
      console.log('Chunk loading failed, falling back to README...');
    } else if (parsed.numbers && parsed.numbers.length > 0) {
      allNumbers = parsed.numbers;
      count = parsed.count || allNumbers.length;
    
      if (allNumbers.length >= 2) {
        const lastTwo = allNumbers.slice(-2);
        a = BigInt(lastTwo[0]);
        b = BigInt(lastTwo[1]);
        currentNumbers = allNumbers.slice(-45);
        console.log(`Loaded ${allNumbers.length} numbers from all.json`);
        console.log(`Resuming from position ${count}`);
        return;
      }
    }
  } catch (error) {
    if (error.status !== 404) {
      console.error('Error loading all.json:', error.message);
    }
  }
  
  // Fall back to README if all.json doesn't exist
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: README_PATH,
    });

    const content = Buffer.from(data.content, 'base64').toString('utf8');
    
    // Parse the total count from Statistics section
    const countMatch = content.match(/Total numbers computed: (\d+)/);
    if (countMatch) {
      count = parseInt(countMatch[1], 10);
      console.log(`Total numbers previously computed: ${count}`);
    }
    
    // Parse the README to get the last numbers
    const match = content.match(/## Latest 45 Digits\n\n```\n([\s\S]*?)\n```/);
    if (match) {
      const numbersText = match[1].trim();
      currentNumbers = numbersText.split('\n')
        .map(line => {
          const parts = line.split(': ');
          return parts.length >= 2 ? parts[1] : null;
        })
        .filter(num => num !== null);
      
      // Get the last two Fibonacci numbers to continue the sequence
      if (currentNumbers.length >= 2) {
        const lastTwo = currentNumbers.slice(-2);
        a = BigInt(lastTwo[0]);
        b = BigInt(lastTwo[1]);
        // Keep allNumbers empty - we'll load from GitHub on save to merge
        // This prevents overwriting existing data with just 45 numbers
        allNumbers = [];
        allNumbersNeedsFetch = true; // Flag to fetch existing data before saving
        console.log(`Resuming from position ${count}`);
        console.log(`Last two numbers loaded for sequence continuation`);
        console.log(`Note: allNumbers will be fetched from GitHub before next save`);
      }
    }
  } catch (error) {
    if (error.status === 404) {
      console.log('No previous state found, starting fresh');
    } else {
      console.error('Error loading state from GitHub:', error.message);
    }
  }
}

// Save state to GitHub with queuing mechanism
async function saveStateToGitHub() {
  // Check if GitHub is available
  if (!githubAvailable) {
    // Try to check again in case repo was created
    const available = await checkRepositoryExists();
    if (!available) {
      console.log('GitHub save skipped - repository not available');
      return;
    }
  }

  // If already saving, mark that we need another save with latest data
  if (isSaving) {
    pendingSave = true;
    console.log('Save already in progress, queuing latest state...');
    return;
  }

  isSaving = true;
  pendingSave = false;

  try {
    // Capture current state at the moment of save
    const saveCount = count;
    const saveLast45 = currentNumbers.slice(-45);
    
    const startPosition = Math.max(1, saveCount - saveLast45.length + 1);
    const numbersText = saveLast45.map((num, idx) => {
      const position = startPosition + idx;
      return `${position}: ${num}`;
    }).join('\n');

    const readmeContent = `# Infinity Runner - Number Computation

This repository stores the progress of the Infinity Runner number computation.

## Latest 45 Digits

\`\`\`
${numbersText}
\`\`\`

## Statistics

- Total numbers computed: ${saveCount}
- Last updated: ${new Date().toISOString()}

## About

This is an automated computation running a Fibonacci sequence. The server computes numbers continuously and saves progress every 10 minutes.
`;

    // Check if file exists
    let sha;
    try {
      const { data } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: README_PATH,
      });
      sha = data.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    // Update or create file
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: README_PATH,
      message: `Update computation progress: ${saveCount} numbers computed`,
      content: Buffer.from(readmeContent).toString('base64'),
      ...(sha && { sha }),
    });

    console.log(`Saved README to GitHub: ${saveCount} numbers`);

    // Queue the all.json save to run async without blocking
    queueAllNumbersSave(saveCount);
    
    lastSaveTime = new Date();
    
    // Notify all clients about the save
    broadcast({
      type: 'save',
      lastSaveTime: lastSaveTime.toISOString(),
      count: saveCount
    });
  } catch (error) {
    console.error('Error saving to GitHub:', error.message);
  } finally {
    isSaving = false;
    
    // If a save was requested while we were saving, trigger another save with latest data
    if (pendingSave) {
      console.log('Processing queued save with latest data...');
      // Use setImmediate to avoid blocking and allow computation to continue
      setImmediate(() => saveStateToGitHub());
    }
  }
}

// Queue all.json save operation
function queueAllNumbersSave(saveCount) {
  const numbersSnapshot = [...allNumbers];
  saveQueue.push({ count: saveCount, numbers: numbersSnapshot });
  processQueue();
}

// Process save queue without blocking computation
async function processQueue() {
  if (isProcessingQueue || saveQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (saveQueue.length > 0) {
    // Only process the latest save, skip older ones
    const job = saveQueue.pop();
    saveQueue.length = 0; // Clear remaining older jobs
    
    try {
      await saveAllNumbersToGitHub(job.count, job.numbers);
    } catch (error) {
      console.error('Queue save error:', error.message);
    }
    
    // Small delay to not hammer GitHub API
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  isProcessingQueue = false;
}

// Save all numbers - only append new ones to GitHub
async function saveAllNumbersToGitHub(saveCount, numbers) {
  let existingNumbers = [];
  let allJsonSha;
  
  // First, fetch existing data from GitHub
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: ALL_NUMBERS_PATH,
    });
    allJsonSha = data.sha;
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    
    // Check if it's actual numbers array or just an old index file
    if (parsed.numbers && Array.isArray(parsed.numbers) && parsed.numbers.length > 0) {
      existingNumbers = parsed.numbers;
      console.log(`Found ${existingNumbers.length} existing numbers on GitHub`);
    } else if (parsed.chunks) {
      // Old chunked index file - we'll overwrite it with actual numbers
      console.log('Found old chunked index file, will overwrite with actual numbers');
    }
  } catch (error) {
    if (error.status === 404) {
      console.log('No existing all.json, creating new file');
    } else {
      // File exists but is corrupted, get its SHA so we can overwrite
      console.log('Existing all.json is corrupted, will overwrite');
      try {
        const { data } = await octokit.repos.getContent({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          path: ALL_NUMBERS_PATH,
        });
        allJsonSha = data.sha;
      } catch (e) {
        // Ignore
      }
    }
  }

  // Determine which numbers are new (not already on GitHub)
  let numbersToSave;
  if (existingNumbers.length > 0) {
    // Only append numbers that are new
    const existingCount = existingNumbers.length;
    if (numbers.length > existingCount) {
      // We have more numbers than GitHub, append the new ones
      const newNumbers = numbers.slice(existingCount);
      numbersToSave = [...existingNumbers, ...newNumbers];
      console.log(`Appending ${newNumbers.length} new numbers to ${existingCount} existing`);
    } else {
      // GitHub has same or more, just use what's there
      numbersToSave = existingNumbers;
      console.log(`No new numbers to append (GitHub: ${existingCount}, local: ${numbers.length})`);
    }
  } else {
    // No existing data, save all our numbers
    numbersToSave = numbers;
    console.log(`Saving ${numbers.length} numbers (fresh file)`);
  }

  // Format JSON with multiple lines for readability
  const allNumbersData = {
    count: saveCount,
    lastUpdated: new Date().toISOString(),
    totalNumbers: numbersToSave.length,
    numbers: numbersToSave
  };
  
  // Pretty print with 2-space indent
  const jsonContent = JSON.stringify(allNumbersData, null, 2);
  const contentSize = Buffer.byteLength(jsonContent, 'utf8');
  
  console.log(`all.json size: ${(contentSize / 1024 / 1024).toFixed(2)}MB`);
  
  // GitHub has 100MB limit, warn if approaching
  if (contentSize > 90 * 1024 * 1024) {
    console.log('Warning: all.json approaching GitHub size limit. Consider archiving old data.');
  }
  
  // Save the file
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: ALL_NUMBERS_PATH,
    message: `Update all numbers: ${saveCount} total (${numbersToSave.length} stored)`,
    content: Buffer.from(jsonContent).toString('base64'),
    ...(allJsonSha && { sha: allJsonSha }),
  });

  console.log(`Saved all.json to GitHub: ${numbersToSave.length} numbers`);
  
  // Update local allNumbers with merged data
  allNumbers = numbersToSave;
  allNumbersNeedsFetch = false;
}


// Compute next Fibonacci number
function computeNext() {
  const next = a + b;
  a = b;
  b = next;
  
  count++;
  const numStr = next.toString();
  currentNumbers.push(numStr);
  allNumbers.push(numStr); // Add to complete history
  
  // Broadcast to all clients
  broadcast({
    type: 'number',
    number: numStr,
    position: count
  });
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  // Send current state to new client
  ws.send(JSON.stringify({
    type: 'init',
    count: count,
    currentNumber: b.toString(),
    last45: currentNumbers.slice(-45),
    serverSpecs: SERVER_SPECS,
    serverStartTime: serverStartTime.toISOString(),
    lastSaveTime: lastSaveTime.toISOString()
  }));

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Periodic save function (every 5 minutes)
function startPeriodicSave() {
  setInterval(() => {
    if (count > 0) {
      console.log(`Periodic save triggered (5 minutes elapsed, ${count} numbers computed)`);
      // Queue the save - it won't block computation
      saveStateToGitHub();
    }
  }, 5 * 60 * 1000); // 5 minutes in milliseconds
}

// Main computation loop
async function startComputation() {
  // Check if repository exists
  await checkRepositoryExists();
  
  // Load previous state
  await loadStateFromGitHub();
  
  // Start periodic saves
  startPeriodicSave();
  
  console.log('Starting computation...');
  
  // Compute a new number every 100ms
  setInterval(() => {
    computeNext();
  }, 100);
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await saveStateToGitHub();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  await saveStateToGitHub();
  process.exit(0);
});

// API endpoints
app.get('/api/progress', (req, res) => {
    res.json(gameState);
});

app.post('/api/manual-save', async (req, res) => {
    const { pin } = req.body;

    if (!OWNER_PIN) {
        return res.status(500).json({ error: 'Owner PIN not configured on server' });
    }

    if (pin !== OWNER_PIN) {
        return res.status(403).json({ error: 'Invalid PIN' });
    }

    const now = Date.now();
    if (now - lastManualSaveTime < MANUAL_SAVE_COOLDOWN) {
        const remaining = Math.ceil((MANUAL_SAVE_COOLDOWN - (now - lastManualSaveTime)) / 1000);
        return res.status(429).json({ error: `Please wait ${remaining} seconds before saving again` });
    }

    try {
        await saveStateToGitHub();
        lastManualSaveTime = now;
        // Auto-save timer continues independently - no reset
        res.json({ success: true, message: 'Progress saved manually' });
    } catch (error) {
        console.error('Manual save failed:', error);
        res.status(500).json({ error: 'Failed to save progress' });
    }
});

app.post('/api/progress', (req, res) => {
  // ...existing code...
});

// Start the computation
startComputation();
