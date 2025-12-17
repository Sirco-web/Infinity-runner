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
const CHUNK_SIZE = 1000; // Legacy - not used anymore
const MAX_CHUNK_BYTES = 900 * 1024; // 900KB max per chunk (under GitHub's 1MB API limit)
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
let autoSaveStartTime = new Date(); // Tracks when current auto-save cycle started
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

// Split numbers array into chunks based on byte size (not count)
// Each chunk stays under MAX_CHUNK_BYTES, and numbers are never split between chunks
function splitNumbersBySize(numbers) {
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;
  const overhead = 50; // JSON overhead per number (quotes, comma, newline, etc.)
  
  for (const num of numbers) {
    const numSize = num.length + overhead;
    
    // If adding this number would exceed limit, start new chunk
    if (currentSize + numSize > MAX_CHUNK_BYTES && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }
    
    currentChunk.push(num);
    currentSize += numSize;
  }
  
  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

// Check if a chunk needs resplitting (too large)
function chunkNeedsResplit(chunkData) {
  const content = JSON.stringify(chunkData, null, 2);
  return Buffer.byteLength(content, 'utf8') > MAX_CHUNK_BYTES;
}

// Load chunked data from multiple files
async function loadChunkedData(indexData) {
  // Handle both old format (chunks = number) and new format (chunks = array)
  const chunks = Array.isArray(indexData.chunks) ? indexData.chunks : [];
  const numChunks = chunks.length || indexData.chunks || 0;
  
  if (numChunks === 0) {
    console.log('No chunks to load');
    return false;
  }
  
  allNumbers = [];
  let loadedAny = false;
  
  console.log(`Attempting to load ${numChunks} chunk files...`);
  
  for (let i = 0; i < numChunks; i++) {
    // Determine chunk path from index data or try common formats
    let chunkPath;
    if (Array.isArray(indexData.chunks) && indexData.chunks[i]?.path) {
      chunkPath = indexData.chunks[i].path;
    } else {
      chunkPath = `chunks/chunk_${i}.json`;
    }
    
    let loaded = false;
    
    // First try using raw GitHub URL (no size limit)
    try {
      console.log(`Trying to load chunk from raw URL: ${chunkPath}`);
      const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${chunkPath}`;
      const response = await fetch(rawUrl);
      if (response.ok) {
        const content = await response.text();
        const chunkData = JSON.parse(content);
        allNumbers.push(...chunkData.numbers);
        console.log(`Loaded chunk ${i + 1}/${numChunks} from raw URL: ${chunkData.numbers.length} numbers`);
        loaded = true;
        loadedAny = true;
      } else {
        console.log(`  Raw URL failed: ${response.status}`);
      }
    } catch (error) {
      console.log(`  Raw URL error: ${error.message}`);
    }
    
    // Fall back to API if raw URL failed
    if (!loaded) {
      try {
        console.log(`Trying API fallback for: ${chunkPath}`);
        const { data } = await octokit.repos.getContent({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          path: chunkPath,
        });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const chunkData = JSON.parse(content);
        allNumbers.push(...chunkData.numbers);
        console.log(`Loaded chunk ${i + 1}/${numChunks} from API: ${chunkData.numbers.length} numbers`);
        loaded = true;
        loadedAny = true;
      } catch (error) {
        console.log(`  API failed: ${error.status || error.message}`);
      }
    }
    
    if (!loaded) {
      console.log(`Chunk ${i + 1} not found, stopping chunk load`);
      break;
    }
  }
  
  // If we couldn't load chunks, fall back to README
  if (!loadedAny) {
    console.log('No chunks could be loaded, will fall back to README');
    allNumbers = [];
    return false;
  }
  
  // Use totalNumbers from index or count from loaded data
  count = indexData.computedCount || indexData.totalNumbers || allNumbers.length;
  
  if (allNumbers.length >= 2) {
    const lastTwo = allNumbers.slice(-2);
    a = BigInt(lastTwo[0]);
    b = BigInt(lastTwo[1]);
    currentNumbers = allNumbers.slice(-45);
    console.log(`Loaded ${allNumbers.length} numbers from ${numChunks} chunks`);
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
  
  // First, try to load all.json index for chunked data
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: ALL_NUMBERS_PATH,
    });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    
    // Check if data is chunked format (has chunks array)
    if (parsed.chunks && Array.isArray(parsed.chunks) && parsed.chunks.length > 0) {
      console.log(`Found chunked index: ${parsed.chunks.length} chunks, ${parsed.totalNumbers} total numbers`);
      const success = await loadChunkedData(parsed);
      if (success) {
        return;
      }
      console.log('Chunk loading failed, falling back to README...');
    } else if (parsed.numbers && parsed.numbers.length > 0) {
      // Old single-file format
      allNumbers = parsed.numbers;
      count = parsed.count || allNumbers.length;
    
      if (allNumbers.length >= 2) {
        const lastTwo = allNumbers.slice(-2);
        a = BigInt(lastTwo[0]);
        b = BigInt(lastTwo[1]);
        currentNumbers = allNumbers.slice(-45);
        console.log(`Loaded ${allNumbers.length} numbers from all.json (old format)`);
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
        
        // Since we don't have all.json, regenerate all Fibonacci numbers from scratch
        // This ensures we never lose early numbers (0, 1, 1, 2, 3, 5...)
        console.log(`Regenerating ${count} Fibonacci numbers from scratch...`);
        allNumbers = regenerateFibonacciSequence(count);
        currentNumbers = allNumbers.slice(-45);
        allNumbersNeedsFetch = false;
        console.log(`Regenerated ${allNumbers.length} numbers`);
        console.log(`Resuming from position ${count}`);
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

// Regenerate Fibonacci sequence from the beginning
function regenerateFibonacciSequence(targetCount) {
  const numbers = ['0', '1']; // Start with F(0)=0, F(1)=1
  let a = 0n;
  let b = 1n;
  
  for (let i = 2; i < targetCount; i++) {
    const next = a + b;
    a = b;
    b = next;
    numbers.push(next.toString());
  }
  
  return numbers;
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
      autoSaveStartTime: autoSaveStartTime.toISOString(),
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

// Save all numbers using chunked files to avoid GitHub size limits
// Each chunk holds up to CHUNK_SIZE numbers, saved as chunks/chunk_0.json, chunks/chunk_1.json, etc.
// all.json is an index file pointing to all chunks
async function saveAllNumbersToGitHub(saveCount, numbers) {
  // First, get the current index to know what chunks exist
  let indexData = { chunks: [], totalNumbers: 0, lastChunkCount: 0 };
  let indexSha;
  let chunksAreCorrupted = false;
  
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: ALL_NUMBERS_PATH,
    });
    indexSha = data.sha;
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    
    if (parsed.chunks && Array.isArray(parsed.chunks)) {
      // Verify at least the first chunk is readable and check if it needs resplitting
      if (parsed.chunks.length > 0) {
        try {
          const testPath = parsed.chunks[0].path;
          // Try raw URL first for large files
          const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${testPath}`;
          const response = await fetch(rawUrl);
          if (response.ok) {
            const chunkContent = await response.text();
            const chunkData = JSON.parse(chunkContent);
            
            // Check if chunk is too large (by byte size) and needs resplitting
            if (chunkNeedsResplit(chunkData)) {
              console.log(`Chunk 0 is too large (${(Buffer.byteLength(chunkContent, 'utf8') / 1024).toFixed(0)}KB > ${MAX_CHUNK_BYTES / 1024}KB), needs resplitting`);
              chunksAreCorrupted = true; // Will trigger full resave with smaller chunks
            } else {
              indexData = parsed;
              console.log(`Found ${indexData.chunks.length} existing chunks with ${indexData.totalNumbers} numbers`);
            }
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        } catch (chunkError) {
          console.log('Existing chunks are corrupted or unreadable, will reset and save fresh:', chunkError.message);
          chunksAreCorrupted = true;
          indexData = { chunks: [], totalNumbers: 0, lastChunkCount: 0 };
        }
      } else {
        indexData = parsed;
      }
    } else if (parsed.numbers && Array.isArray(parsed.numbers)) {
      // Old single-file format - need to migrate
      console.log(`Migrating ${parsed.numbers.length} numbers from old format to chunks`);
      const oldNumbers = parsed.numbers;
      for (let i = 0; i < oldNumbers.length; i += CHUNK_SIZE) {
        const chunkNumbers = oldNumbers.slice(i, i + CHUNK_SIZE);
        const chunkIndex = Math.floor(i / CHUNK_SIZE);
        await saveChunk(chunkIndex, chunkNumbers);
        indexData.chunks.push({
          index: chunkIndex,
          path: `chunks/chunk_${chunkIndex}.json`,
          count: chunkNumbers.length,
          startPosition: i + 1,
          endPosition: i + chunkNumbers.length
        });
      }
      indexData.totalNumbers = oldNumbers.length;
      indexData.lastChunkCount = oldNumbers.length % CHUNK_SIZE || CHUNK_SIZE;
    }
  } catch (error) {
    if (error.status === 404) {
      console.log('No existing all.json index, creating new chunked storage');
    } else {
      console.log('Error reading index:', error.message);
      chunksAreCorrupted = true;
    }
  }

  // If chunks are corrupted or need resplitting, save all numbers from scratch with size-based chunks
  if (chunksAreCorrupted) {
    console.log(`Saving all ${numbers.length} numbers fresh (resetting corrupted/oversized data)`);
    
    // Try to delete old chunk files first (up to 100 to be safe)
    for (let i = 0; i < 100; i++) {
      const chunkPath = `chunks/chunk_${i}.json`;
      try {
        const { data } = await octokit.repos.getContent({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          path: chunkPath,
        });
        // Delete the file
        await octokit.repos.deleteFile({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          path: chunkPath,
          message: `Delete old chunk ${i}`,
          sha: data.sha,
        });
        console.log(`Deleted old chunk ${i}`);
        await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit
      } catch (e) {
        // File doesn't exist - we're done
        if (e.status === 404) break;
      }
    }
    
    // Small delay after deletions
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Split numbers by byte size, not count
    const numberChunks = splitNumbersBySize(numbers);
    console.log(`Splitting ${numbers.length} numbers into ${numberChunks.length} size-based chunks`);
    
    indexData = { chunks: [], totalNumbers: 0, lastChunkCount: 0 };
    let totalProcessed = 0;
    
    for (let chunkIndex = 0; chunkIndex < numberChunks.length; chunkIndex++) {
      const chunkNumbers = numberChunks[chunkIndex];
      await saveChunk(chunkIndex, chunkNumbers);
      indexData.chunks.push({
        index: chunkIndex,
        path: `chunks/chunk_${chunkIndex}.json`,
        count: chunkNumbers.length,
        startPosition: totalProcessed + 1,
        endPosition: totalProcessed + chunkNumbers.length
      });
      totalProcessed += chunkNumbers.length;
      
      // Rate limit to avoid GitHub API issues
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    indexData.totalNumbers = numbers.length;
    indexData.lastChunkCount = numberChunks[numberChunks.length - 1]?.length || 0;
    indexData.lastUpdated = new Date().toISOString();
    indexData.computedCount = saveCount;
    
    const indexContent = JSON.stringify(indexData, null, 2);
    
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: ALL_NUMBERS_PATH,
      message: `Reset chunks: ${indexData.totalNumbers} numbers in ${indexData.chunks.length} chunks`,
      content: Buffer.from(indexContent).toString('base64'),
      ...(indexSha && { sha: indexSha }),
    });
    
    console.log(`Saved fresh: ${indexData.totalNumbers} numbers in ${indexData.chunks.length} chunks`);
    return;
  }

  // Determine how many new numbers we have
  const existingCount = indexData.totalNumbers;
  const newNumbersCount = numbers.length - existingCount;
  
  if (newNumbersCount <= 0) {
    console.log(`No new numbers to save (have ${numbers.length}, GitHub has ${existingCount})`);
    return;
  }

  console.log(`Saving ${newNumbersCount} new numbers (${existingCount} -> ${numbers.length})`);

  // Get the new numbers to save
  const newNumbers = numbers.slice(existingCount);
  
  // Determine which chunk to append to or create
  let currentChunkIndex = indexData.chunks.length > 0 ? indexData.chunks.length - 1 : 0;
  let currentChunkCount = indexData.lastChunkCount || 0;
  let numbersProcessed = 0;
  
  while (numbersProcessed < newNumbers.length) {
    // How many numbers can fit in current chunk?
    const spaceInChunk = CHUNK_SIZE - currentChunkCount;
    
    if (spaceInChunk > 0 && currentChunkCount > 0) {
      // Append to existing chunk
      const numbersToAdd = newNumbers.slice(numbersProcessed, numbersProcessed + spaceInChunk);
      await appendToChunk(currentChunkIndex, numbersToAdd);
      
      numbersProcessed += numbersToAdd.length;
      currentChunkCount += numbersToAdd.length;
      
      // Update chunk info in index
      if (indexData.chunks[currentChunkIndex]) {
        indexData.chunks[currentChunkIndex].count = currentChunkCount;
        indexData.chunks[currentChunkIndex].endPosition = existingCount + numbersProcessed;
      }
      
      console.log(`Appended ${numbersToAdd.length} numbers to chunk ${currentChunkIndex}`);
    }
    
    // If chunk is full or we have more numbers, create new chunks
    if (currentChunkCount >= CHUNK_SIZE && numbersProcessed < newNumbers.length) {
      currentChunkIndex++;
      currentChunkCount = 0;
    }
    
    // Create new chunk if needed
    if (currentChunkCount === 0 && numbersProcessed < newNumbers.length) {
      const numbersForNewChunk = newNumbers.slice(numbersProcessed, numbersProcessed + CHUNK_SIZE);
      await saveChunk(currentChunkIndex, numbersForNewChunk);
      
      indexData.chunks.push({
        index: currentChunkIndex,
        path: `chunks/chunk_${currentChunkIndex}.json`,
        count: numbersForNewChunk.length,
        startPosition: existingCount + numbersProcessed + 1,
        endPosition: existingCount + numbersProcessed + numbersForNewChunk.length
      });
      
      numbersProcessed += numbersForNewChunk.length;
      currentChunkCount = numbersForNewChunk.length;
      
      console.log(`Created chunk ${currentChunkIndex} with ${numbersForNewChunk.length} numbers`);
    }
  }

  // Update index file
  indexData.totalNumbers = existingCount + newNumbersCount;
  indexData.lastChunkCount = currentChunkCount;
  indexData.lastUpdated = new Date().toISOString();
  indexData.computedCount = saveCount;
  
  const indexContent = JSON.stringify(indexData, null, 2);
  
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: ALL_NUMBERS_PATH,
    message: `Update index: ${indexData.totalNumbers} numbers in ${indexData.chunks.length} chunks`,
    content: Buffer.from(indexContent).toString('base64'),
    ...(indexSha && { sha: indexSha }),
  });

  console.log(`Saved all.json index: ${indexData.totalNumbers} numbers in ${indexData.chunks.length} chunks`);
}

// Save a new chunk file
async function saveChunk(chunkIndex, numbers) {
  const chunkPath = `chunks/chunk_${chunkIndex}.json`;
  const chunkData = {
    chunkIndex,
    count: numbers.length,
    numbers: numbers
  };
  
  const content = JSON.stringify(chunkData, null, 2);
  const contentSize = Buffer.byteLength(content, 'utf8');
  console.log(`Chunk ${chunkIndex} size: ${(contentSize / 1024 / 1024).toFixed(2)}MB`);
  
  // Check if file is too large (GitHub limit is ~100MB but API has issues with large files)
  if (contentSize > 50 * 1024 * 1024) {
    console.log(`Warning: Chunk ${chunkIndex} is very large (${(contentSize / 1024 / 1024).toFixed(2)}MB)`);
  }
  
  // Check if chunk exists (for SHA) - needed to overwrite
  let sha;
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: chunkPath,
    });
    sha = data.sha;
    console.log(`Found existing chunk ${chunkIndex}, will overwrite (SHA: ${sha.substring(0, 7)})`);
  } catch (e) {
    // New file - that's fine
  }
  
  try {
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: chunkPath,
      message: `Create chunk ${chunkIndex}: ${numbers.length} numbers`,
      content: Buffer.from(content).toString('base64'),
      ...(sha && { sha }),
    });
    console.log(`Saved chunk ${chunkIndex}: ${numbers.length} numbers`);
  } catch (error) {
    console.error(`Error saving chunk ${chunkIndex}: ${error.status} - ${error.message}`);
    throw error;
  }
}

// Append numbers to an existing chunk (or recreate if corrupted)
async function appendToChunk(chunkIndex, newNumbers, existingNumbers = []) {
  const chunkPath = `chunks/chunk_${chunkIndex}.json`;
  
  let sha;
  let currentNumbers = existingNumbers;
  
  // Try to get existing chunk
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: chunkPath,
    });
    sha = data.sha;
    
    const existingContent = Buffer.from(data.content, 'base64').toString('utf8');
    const chunkData = JSON.parse(existingContent);
    currentNumbers = chunkData.numbers || [];
  } catch (error) {
    if (error.status === 404) {
      console.log(`Chunk ${chunkIndex} doesn't exist, creating new`);
    } else if (error.message?.includes('JSON')) {
      console.log(`Chunk ${chunkIndex} is corrupted, will overwrite`);
      // Get SHA to overwrite corrupted file
      try {
        const { data } = await octokit.repos.getContent({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          path: chunkPath,
        });
        sha = data.sha;
      } catch (e) {}
    } else {
      throw error;
    }
  }
  
  // Append new numbers
  const allNumbers = [...currentNumbers, ...newNumbers];
  
  const chunkData = {
    chunkIndex,
    count: allNumbers.length,
    numbers: allNumbers
  };
  
  const content = JSON.stringify(chunkData, null, 2);
  
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: chunkPath,
    message: `Update chunk ${chunkIndex}: ${allNumbers.length} numbers`,
    content: Buffer.from(content).toString('base64'),
    ...(sha && { sha }),
  });
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
    lastSaveTime: lastSaveTime.toISOString(),
    autoSaveStartTime: autoSaveStartTime.toISOString()
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
      // Reset auto-save timer for the next cycle
      autoSaveStartTime = new Date();
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
  
  // If starting fresh, add the initial Fibonacci numbers (0, 1) to the history
  if (count === 0 && allNumbers.length === 0) {
    console.log('Starting fresh - adding initial Fibonacci numbers (0, 1)');
    // Add the starting numbers to the history
    // Position 1 = 0, Position 2 = 1 (these are a and b before any computation)
    allNumbers.push('0');  // F(0) = 0
    allNumbers.push('1');  // F(1) = 1
    currentNumbers.push('0');
    currentNumbers.push('1');
    count = 2;  // We already have 2 numbers
    // a=0, b=1 are already set, so next computeNext() will compute F(2) = 1
  }
  
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
