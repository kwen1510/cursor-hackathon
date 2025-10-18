const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const app = express();

// Supabase configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing Supabase credentials! Please check your .env file.');
  process.exit(1);
}

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
  const response = await supabaseRequest('/lessons?select=*');
  return await response.json();
}

async function getLessonBySessionId(sessionId) {
  const response = await supabaseRequest(`/lessons?session_id=eq.${sessionId}&select=*`);
  const lessons = await response.json();
  return lessons.length > 0 ? lessons[0] : null;
}

async function getTranscriptsByLessonId(lessonId) {
  const response = await supabaseRequest(`/transcripts?lesson_id=eq.${lessonId}&select=*&order=start_time`);
  return await response.json();
}

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use(express.json({ limit: '2mb' }));

// Legacy file reading function - no longer used with Supabase

app.get('/api/video-metadata', async (req, res) => {
  try {
    const lessons = await getLessons();
    // Transform Supabase lessons to match the expected format
    const metadata = lessons.map(lesson => ({
      sessionId: lesson.session_id,
      title: lesson.title,
      uploadedAt: lesson.uploaded_at,
      transcriptFile: lesson.transcript_file
    }));
    res.json(metadata);
  } catch (e) {
    console.error('Error fetching video metadata:', e);
    res.status(500).json({ error: 'Could not fetch metadata from Supabase' });
  }
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

    const transcripts = await getTranscriptsByLessonId(lesson.id);
    
    // Transform transcripts to match expected format
    const timestamps = transcripts.map(transcript => ({
      speaker: transcript.speaker,
      start: transcript.start_time,
      end: transcript.end_time,
      text: transcript.text,
      role: transcript.role
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

    const transcripts = await getTranscriptsByLessonId(lesson.id);
    
    // Transform data to match expected format
    const lessonData = {
      meta: {
        sessionId: lesson.session_id,
        title: lesson.title,
        uploadedAt: lesson.uploaded_at,
        transcriptFile: lesson.transcript_file
      },
      transcript: transcripts.map(transcript => ({
        speaker: transcript.speaker,
        start: transcript.start_time,
        end: transcript.end_time,
        text: transcript.text,
        role: transcript.role
      }))
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
    database: 'Supabase',
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
