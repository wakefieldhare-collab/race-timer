const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3457;
const DATA_FILE = path.join(__dirname, 'data.json');
const BACKUP_DIR = path.join(__dirname, 'backups');

const DEFAULT_DATA = {
  athletes: [],
  races: []
};

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR);
}

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading data.json:', e.message);
  }
  return { ...DEFAULT_DATA, athletes: [], races: [] };
}

function backupData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const current = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (current.races && current.races.length > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(BACKUP_DIR, `data-${ts}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(current, null, 2));
        console.log(`Backup created: ${backupPath} (${current.races.length} races)`);
      }
      // Keep only last 20 backups
      const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('data-') && f.endsWith('.json'))
        .sort();
      while (backups.length > 20) {
        fs.unlinkSync(path.join(BACKUP_DIR, backups.shift()));
      }
    }
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Initialize data file if missing
if (!fs.existsSync(DATA_FILE)) {
  writeData(DEFAULT_DATA);
}

app.use(express.json({ limit: '5mb' }));

// CORS: allow GitHub Pages and Tailscale to call the API
app.use('/api', (req, res, next) => {
  const allowed = ['https://wakefieldhare-collab.github.io', 'https://gtf-desktop.tail98708b.ts.net:3457'];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, PUT');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(__dirname));

app.get('/api/data', (req, res) => {
  res.json(readData());
});

app.put('/api/data', (req, res) => {
  const incoming = req.body;
  const current = readData();

  // Safety check: reject writes that would lose races without explicit override
  if (current.races && current.races.length > 0) {
    const incomingRaceCount = (incoming.races || []).length;
    if (incomingRaceCount < current.races.length) {
      const existingIds = new Set(current.races.map(r => r.id));
      const newRaces = (incoming.races || []).filter(r => !existingIds.has(r.id));
      incoming.races = [...newRaces, ...current.races];
      console.log(`Merge: kept ${current.races.length} existing + ${newRaces.length} new races (client sent ${incomingRaceCount})`);
    }
  }

  backupData();
  writeData(incoming);
  res.json({ ok: true, raceCount: incoming.races.length });
});

// Recovery endpoint: list available backups
app.get('/api/backups', (req, res) => {
  try {
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('data-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8'));
        return {
          file: f,
          raceCount: (data.races || []).length,
          size: fs.statSync(path.join(BACKUP_DIR, f)).size
        };
      });
    res.json({ backups });
  } catch (e) {
    res.json({ backups: [] });
  }
});

// Recovery endpoint: restore from backup
app.put('/api/restore', (req, res) => {
  const { file } = req.body;
  if (!file || !file.match(/^data-[\w-]+\.json$/)) {
    return res.status(400).json({ error: 'Invalid backup file' });
  }
  const backupPath = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  try {
    backupData();
    const restored = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    writeData(restored);
    res.json({ ok: true, raceCount: (restored.races || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recovery endpoint: accept races from client localStorage
app.put('/api/recover', (req, res) => {
  const clientRaces = req.body.races || [];
  if (clientRaces.length === 0) {
    return res.json({ ok: true, message: 'No races to recover', raceCount: 0 });
  }
  const current = readData();
  backupData();
  const existingIds = new Set(current.races.map(r => r.id));
  const newRaces = clientRaces.filter(r => !existingIds.has(r.id));
  current.races = [...newRaces, ...current.races];
  current.races.sort((a, b) => new Date(b.date) - new Date(a.date));
  writeData(current);
  console.log(`Recovery: merged ${newRaces.length} new races from client (${clientRaces.length} submitted, ${current.races.length} total)`);
  res.json({ ok: true, recovered: newRaces.length, raceCount: current.races.length });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Race Timer running on http://0.0.0.0:${PORT}`);
});
