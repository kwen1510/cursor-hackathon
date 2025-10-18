const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const app = express();

// Supabase configuration (optional now). If not present, we read Phase 1 OUTPUT_LESSONS locally.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);

// Local lessons directory from Phase 1 pipeline
const LOCAL_LESSONS_DIR = path.join(__dirname, '..', 'Phase_1_Extract_Transcript', 'OUTPUT_LESSONS');

// Supabase helper functions
async function supabaseRequest(endpoint, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1${endpoint}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...options.headers
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (!response.ok) {
    throw new Error(`Supabase request failed: ${response.status} ${response.statusText}`);
  }

  return response;
}

async function getLessons() {
  if (!USE_SUPABASE) return getLocalLessons();
  const response = await supabaseRequest('/lessons?select=id,session_id,title,uploaded_at,transcript_content,transcript_file,analysis');
  return await response.json();
}

function toDisplayDateTime(isoLike) {
  try {
    const d = new Date(isoLike);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} - ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return isoLike;
  }
}

async function getLessonBySessionId(sessionId) {
  if (!USE_SUPABASE) return getLocalLessonBySessionId(sessionId);
  const response = await supabaseRequest(`/lessons?session_id=eq.${sessionId}&select=id,session_id,title,uploaded_at,transcript_content,transcript_file,analysis`);
  const lessons = await response.json();
  return lessons.length > 0 ? lessons[0] : null;
}

// No longer needed - transcripts are stored as jsonb in lessons.transcript_content

// ---------- Local JSON helpers (OUTPUT_LESSONS) ----------
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function getLocalLessons() {
  if (!fs.existsSync(LOCAL_LESSONS_DIR)) return [];
  const files = fs.readdirSync(LOCAL_LESSONS_DIR).filter(f => f.endsWith('.json'));
  const rows = [];
  for (const f of files) {
    const obj = readJsonSafe(path.join(LOCAL_LESSONS_DIR, f));
    if (obj && obj.sessionId) {
      rows.push({
        id: obj.sessionId,
        session_id: obj.sessionId,
        title: obj.title || 'Lesson',
        uploaded_at: obj.uploadedAt || null,
        transcript_content: Array.isArray(obj.transcript) ? obj.transcript : []
      });
    }
  }
  return rows;
}

function getLocalLessonBySessionId(sessionId) {
  const p = path.join(LOCAL_LESSONS_DIR, `${sessionId}.json`);
  const obj = readJsonSafe(p);
  if (!obj) return null;
  return {
    id: obj.sessionId,
    session_id: obj.sessionId,
    title: obj.title || 'Lesson',
    uploaded_at: obj.uploadedAt || null,
    transcript_content: Array.isArray(obj.transcript) ? obj.transcript : []
  };
}

const PORT = process.env.PORT || 3000;
const PROMPTS_DIR = path.join(__dirname, 'PROMPTS');

app.use(express.static(__dirname));
app.use(express.json({ limit: '2mb' }));

// Serve prompts from new PROMPTS directory (fallback to VIDEO_METADATA for backward compat)
app.get('/PROMPTS/:file', (req, res) => {
  const filePath = path.join(PROMPTS_DIR, req.params.file);
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  // Fallback
  const legacy = path.join(__dirname, 'VIDEO_METADATA', req.params.file);
  if (fs.existsSync(legacy)) return res.sendFile(legacy);
  return res.status(404).send('Not found');
});

// Legacy file reading function - no longer used with Supabase

app.get('/api/video-metadata', async (req, res) => {
  try {
    const lessons = await getLessons();
    // Transform Supabase lessons to match the expected format
    const metadata = lessons.map(lesson => ({
      sessionId: lesson.session_id,
      title: lesson.title,
      uploadedAt: lesson.uploaded_at,
      uploadedAtFormatted: toDisplayDateTime(lesson.uploaded_at),
      transcriptFile: lesson.transcript_file || null
    }));
    res.json(metadata);
  } catch (e) {
    console.error('Error fetching video metadata:', e);
    res.status(500).json({ error: 'Could not fetch metadata from Supabase' });
  }
});

// Optional endpoint to serve combined lessons JSON if created by Phase 1 script
app.get('/api/combined-lessons', (req, res) => {
  const p = path.join(__dirname, 'combined_lessons.json');
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.status(404).json({ error: 'combined_lessons.json not found. Run Phase_1_Extract_Transcript/04_create_metadata_and_transcript.py' });
});

app.get('/api/timestamps', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId parameter is required' });
    }

    const lesson = await getLessonBySessionId(sessionId);
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    // Extract timestamps from transcript_content jsonb (both Supabase and local)
    const arr = Array.isArray(lesson.transcript_content) ? lesson.transcript_content : [];
    const timestamps = arr.map(t => ({ 
      speaker: t.speaker, 
      start: t.start, 
      end: t.end, 
      text: t.text, 
      role: t.role 
    }));

    res.json(timestamps);
  } catch (e) {
    console.error('Error fetching timestamps:', e);
    res.status(500).json({ error: 'Could not fetch timestamps from Supabase' });
  }
});

// Combined lesson endpoint - matches by sessionId only
app.get('/api/lesson/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    
    const lesson = await getLessonBySessionId(sessionId);
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    // Extract transcript from transcript_content jsonb (both Supabase and local)
    const transcriptArr = (Array.isArray(lesson.transcript_content) ? lesson.transcript_content : []).map(t => ({
      speaker: t.speaker, start: t.start, end: t.end, text: t.text, role: t.role
    }));

    const lessonData = {
      meta: {
        sessionId: lesson.session_id,
        title: lesson.title,
        uploadedAt: lesson.uploaded_at,
        transcriptFile: lesson.transcript_file || null
      },
      transcript: transcriptArr
    };

    res.json(lessonData);
  } catch (e) {
    console.error('Error fetching lesson:', e);
    res.status(500).json({ error: 'Could not fetch lesson from Supabase' });
  }
});

// Simple raw-audio transcription endpoint for Groq Whisper
app.post('/api/realtime/transcribe', express.raw({ type: ['audio/webm', 'audio/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY) return res.status(400).json({ error: 'Missing GROQ_API_KEY' });
    
    const audioBuffer = req.body;
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/webm' }), 'audio.webm');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'en');
    formData.append('response_format', 'json');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Groq API error:', response.status, errorText);
      return res.status(response.status).json({ error: 'Groq API error', details: errorText });
    }

    const result = await response.json();
    res.json({ text: result.text });
  } catch (error) {
    console.error('Groq Whisper API error:', error);
    res.status(500).json({ error: 'Failed to transcribe audio', details: String(error) });
  }
});

// POST /api/analyze - send text to Claude Sonnet for analysis with a given prompt
app.post('/api/analyze', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'Missing ANTHROPIC_API_KEY' });
    const { prompt, text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Missing text' });

    const payload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      system: prompt || 'You are an expert pedagogy analyst. Analyze the lesson.',
      messages: [
        { role: 'user', content: text }
      ]
    };

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const dataText = await resp.text();
    try { return res.status(resp.status).json(JSON.parse(dataText)); }
    catch { return res.status(resp.status).send(dataText); }
  } catch (e) {
    res.status(500).json({ error: 'Analysis failed', details: String(e) });
  }
});

// Streaming Claude endpoint (text/event-stream-like over fetch streaming)
app.post('/api/analyze/stream', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'Missing ANTHROPIC_API_KEY' });
    const { prompt, text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Missing text' });

    // Enable chunked response
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    const payload = {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      stream: true,
      system: prompt || 'You are an expert pedagogy analyst. Analyze the lesson.',
      messages: [
        { role: 'user', content: text }
      ]
    };

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!upstream.body) {
      const txt = await upstream.text();
      res.status(upstream.status).end(txt);
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let buffer = '';
    
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        
        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content_block_delta' && data.delta && data.delta.type === 'text_delta') {
                // Send only the text content
                res.write(`data: ${JSON.stringify({ text: data.delta.text })}\n\n`);
              }
            } catch (e) {
              // Skip malformed JSON
            }
          }
        }
      }
    }
    
    // Send end signal
    res.write(`data: ${JSON.stringify({ end: true })}\n\n`);
    res.end();
  } catch (e) {
    try { res.write('Error: ' + String(e)); } catch {}
    res.end();
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: USE_SUPABASE ? 'Supabase' : 'Local JSON (OUTPUT_LESSONS)',
    endpoints: [
      'GET /api/video-metadata',
      'GET /api/timestamps?sessionId=<sessionId>',
      'GET /api/lesson/:sessionId',
      'POST /api/realtime/transcribe',
      'POST /api/analyze',
      'POST /api/analyze/stream'
    ]
  });
});

app.listen(PORT, () => {
  console.log(`Express server running: http://localhost:${PORT}`);
});
