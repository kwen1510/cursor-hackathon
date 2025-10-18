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

const PORT = 3000;
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
app.post('/api/realtime/transcribe', express.raw({ type: ['application/octet-stream', 'audio/webm', 'audio/wav'], limit: '25mb' }), async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY) return res.status(400).json({ error: 'Missing GROQ_API_KEY' });
    
    const audioBuffer = req.body;
    
    // Check if we have valid audio data
    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }
    
    const formData = new FormData();
    // Use webm format which is what the browser records in
    const blob = new Blob([audioBuffer], { type: 'audio/webm' });
    formData.append('file', blob, 'audio.webm');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
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

// ========== FLAG ENDPOINTS ==========

// Get all flags for a lesson
app.get('/api/flags', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    
    if (!USE_SUPABASE) {
      // Local mode: use in-memory or file-based storage (simplified for now)
      return res.json([]);
    }
    
    const response = await supabaseRequest(`/flags?session_id=eq.${sessionId}&select=*&order=timestamp`);
    const flags = await response.json();
    res.json(flags);
  } catch (e) {
    console.error('Error fetching flags:', e);
    res.status(500).json({ error: 'Failed to fetch flags' });
  }
});

// Create a new flag
app.post('/api/flags', async (req, res) => {
  try {
    const { sessionId, timestamp, text, speaker, role, note } = req.body;
    if (!sessionId || timestamp === undefined) {
      return res.status(400).json({ error: 'sessionId and timestamp required' });
    }
    
    if (!USE_SUPABASE) {
      return res.status(501).json({ error: 'Flags require Supabase' });
    }
    
    // Get lesson_id from session_id
    const lesson = await getLessonBySessionId(sessionId);
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
    
    // Check if flag already exists for this timestamp
    const checkResponse = await supabaseRequest(`/flags?session_id=eq.${sessionId}&timestamp=eq.${parseInt(timestamp)}&select=*`);
    const existing = await checkResponse.json();
    
    if (existing && existing.length > 0) {
      // Return existing flag instead of creating duplicate
      return res.json(existing[0]);
    }
    
    const payload = [{
      lesson_id: lesson.id,
      session_id: sessionId,
      timestamp: parseInt(timestamp),
      text: text || '',
      speaker: speaker || '',
      role: role || '',
      note: note || ''
    }];
    
    const response = await supabaseRequest('/flags?select=*', {
      method: 'POST',
      headers: {
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Supabase error: ${errorText}`);
    }
    
    const result = await response.json();
    res.json(result[0] || { success: true });
  } catch (e) {
    console.error('Error creating flag:', e);
    res.status(500).json({ error: 'Failed to create flag' });
  }
});

// Update flag note
app.put('/api/flags/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    
    if (!USE_SUPABASE) {
      return res.status(501).json({ error: 'Flags require Supabase' });
    }
    
    const response = await supabaseRequest(`/flags?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ note: note || '' })
    });
    
    res.json({ success: true });
  } catch (e) {
    console.error('Error updating flag:', e);
    res.status(500).json({ error: 'Failed to update flag' });
  }
});

// Delete a flag
app.delete('/api/flags/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!USE_SUPABASE) {
      return res.status(501).json({ error: 'Flags require Supabase' });
    }
    
    await supabaseRequest(`/flags?id=eq.${id}`, {
      method: 'DELETE'
    });
    
    res.json({ success: true });
  } catch (e) {
    console.error('Error deleting flag:', e);
    res.status(500).json({ error: 'Failed to delete flag' });
  }
});

// ========== MANUS WEBHOOK ENDPOINT ==========

// Webhook endpoint for Manus notifications
app.post('/api/webhook/manus', async (req, res) => {
  try {
    const webhookData = req.body;
    
    // Log the webhook event
    console.log('\n=== MANUS WEBHOOK RECEIVED ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Event Type:', webhookData.event_type);
    console.log('Event ID:', webhookData.event_id);
    
    if (webhookData.task_detail) {
      console.log('\n--- Task Details ---');
      console.log('Task ID:', webhookData.task_detail.task_id);
      console.log('Task Title:', webhookData.task_detail.task_title);
      console.log('Task URL:', webhookData.task_detail.task_url);
      
      if (webhookData.task_detail.message) {
        console.log('Message:', webhookData.task_detail.message);
      }
      
      if (webhookData.task_detail.stop_reason) {
        console.log('Stop Reason:', webhookData.task_detail.stop_reason);
      }
      
      if (webhookData.task_detail.attachments && webhookData.task_detail.attachments.length > 0) {
        console.log('\n--- Attachments ---');
        webhookData.task_detail.attachments.forEach((attachment, idx) => {
          console.log(`Attachment ${idx + 1}:`);
          console.log('  File Name:', attachment.file_name);
          console.log('  URL:', attachment.url);
          console.log('  Size:', (attachment.size_bytes / 1024).toFixed(2), 'KB');
        });
      }
    }
    
    // Log full payload for reference
    console.log('\n--- FULL MANUS WEBHOOK ---');
    console.log(JSON.stringify(webhookData, null, 2));
    console.log('=============================\n');
    
    // Update Supabase when research is complete
    if (webhookData.event_type === 'task_stopped' && USE_SUPABASE) {
      try {
        console.log('💾 Updating Supabase with research results...');
        
        const taskId = webhookData.task_detail?.task_id;
        const researchOutput = webhookData.task_detail?.message || '';
        const researchSources = webhookData.task_detail?.attachments || [];
        
        console.log(`📎 Extracted ${researchSources.length} attachment(s) from webhook`);
        if (researchSources.length > 0) {
          researchSources.forEach((att, idx) => {
            console.log(`  ${idx + 1}. ${att.file_name} (${att.size_bytes} bytes)`);
            console.log(`     URL: ${att.url}`);
          });
        }
        
        // Find the session with matching manus_task_id
        const findResponse = await supabaseRequest(
          `/onboarding_sessions?manus_task_id=eq.${taskId}&select=*`
        );
        
        if (findResponse.ok) {
          const sessions = await findResponse.json();
          if (sessions && sessions.length > 0) {
            const sessionId = sessions[0].id;
            
            // Update the session
            const updatePayload = {
              research_output: researchOutput,
              research_sources: researchSources,
              status: 'completed',
              updated_at: new Date().toISOString()
            };
            
            const updateResponse = await supabaseRequest(
              `/onboarding_sessions?id=eq.${sessionId}`,
              {
                method: 'PATCH',
                body: JSON.stringify(updatePayload)
              }
            );
            
            if (updateResponse.ok) {
              console.log('✅ Supabase updated successfully for session:', sessionId);
              console.log(`   ✓ Research output: ${researchOutput.substring(0, 100)}...`);
              console.log(`   ✓ Resources saved: ${researchSources.length} file(s)`);
            } else {
              console.error('⚠️ Failed to update Supabase:', updateResponse.status);
            }
          } else {
            console.log('⚠️ No matching session found for task_id:', taskId);
          }
        }
      } catch (error) {
        console.error('⚠️ Supabase update error:', error);
      }
    }
    
    // Send email notification (non-blocking)
    if (process.env.APPSCRIPT_EMAIL && webhookData.event_type === 'task_stopped') {
      sendManusEmailNotification(webhookData).catch(err => {
        console.error('Email notification error:', err);
      });
    }
    
    // Respond with 200 status as required by Manus
    res.status(200).json({ 
      success: true, 
      message: 'Webhook received and logged',
      received_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error processing webhook:', error);
    // Still return 200 to acknowledge receipt
    res.status(200).json({ 
      success: false, 
      error: 'Error processing webhook, but acknowledged' 
    });
  }
});

// Helper function to format markdown-style text to HTML
function formatMessageToHtml(text) {
  if (!text) return '';
  
  // Convert **bold** to <strong>
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  
  // Convert bullet points (• ) to proper list items
  let lines = text.split('\n');
  let inList = false;
  let formatted = [];
  
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('•') || line.startsWith('*')) {
      if (!inList) {
        formatted.push('<ul style="margin: 16px 0; padding-left: 20px;">');
        inList = true;
      }
      let content = line.replace(/^[•*]\s*/, '');
      formatted.push(`<li style="margin: 8px 0; line-height: 1.6;">${content}</li>`);
    } else if (line.startsWith('#')) {
      if (inList) {
        formatted.push('</ul>');
        inList = false;
      }
      // Handle headers
      let level = line.match(/^#+/)[0].length;
      let content = line.replace(/^#+\s*/, '');
      formatted.push(`<h${Math.min(level + 2, 6)} style="margin: 20px 0 12px 0; color: #1e293b;">${content}</h${Math.min(level + 2, 6)}>`);
    } else if (line) {
      if (inList) {
        formatted.push('</ul>');
        inList = false;
      }
      formatted.push(`<p style="margin: 12px 0; line-height: 1.6;">${line}</p>`);
    }
  }
  
  if (inList) {
    formatted.push('</ul>');
  }
  
  return formatted.join('');
}

// Helper function to send email notification for Manus webhooks
async function sendManusEmailNotification(webhookData) {
  const APPSCRIPT_EMAIL = process.env.APPSCRIPT_EMAIL;
  
  if (!APPSCRIPT_EMAIL) {
    console.log('⚠️  APPSCRIPT_EMAIL not configured, skipping email notification');
    return false;
  }
  
  try {
    const taskDetail = webhookData.task_detail || {};
    const eventType = webhookData.event_type;
    
    let subject = '';
    let htmlBody = '';
    
    if (eventType === 'task_stopped') {
      const stopReason = taskDetail.stop_reason;
      const isFinished = stopReason === 'finish';
      
      subject = isFinished 
        ? `Teaching Research Complete: ${taskDetail.task_title || 'Untitled'}`
        : `Teaching Research Needs Input: ${taskDetail.task_title || 'Untitled'}`;
      
      const appBaseUrl = process.env.APP_URL || 'http://localhost:3000';
      
      htmlBody = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff;">
          <div style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: white; padding: 30px 24px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 700;">${isFinished ? 'Teaching Research Completed' : 'Research Awaiting Input'}</h1>
          </div>
          
          <div style="background: #f8fafc; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
            <div style="background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e2e8f0;">
              <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #1e293b; font-weight: 600;">Task: ${taskDetail.task_title || 'N/A'}</h2>
              <div style="display: inline-block; background: ${isFinished ? '#dcfce7' : '#fef3c7'}; color: ${isFinished ? '#166534' : '#854d0e'}; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600;">
                ${isFinished ? 'Completed' : 'Waiting for your input'}
              </div>
            </div>
            
            ${taskDetail.message ? `
              <div style="background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e2e8f0;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #1e293b; font-weight: 600;">Summary</h3>
                <div style="color: #475569; font-size: 14px;">
                  ${formatMessageToHtml(taskDetail.message)}
                </div>
              </div>
            ` : ''}
            
            ${taskDetail.attachments && taskDetail.attachments.length > 0 ? `
              <div style="background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e2e8f0;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #1e293b; font-weight: 600;">Research Resources</h3>
                <ul style="margin: 0; padding: 0; list-style: none;">
                  ${taskDetail.attachments.map(att => `
                    <li style="margin-bottom: 12px; padding: 12px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
                      <a href="${att.url}" style="color: #3b82f6; text-decoration: none; font-weight: 500; font-size: 14px;">${att.file_name}</a>
                      <span style="color: #94a3b8; font-size: 12px; margin-left: 8px;">(${(att.size_bytes / 1024).toFixed(1)} KB)</span>
                    </li>
                  `).join('')}
                </ul>
              </div>
            ` : ''}
            
            <div style="text-align: center; margin: 30px 0 20px 0;">
              <a href="${appBaseUrl}?mode=onboarding" style="display: inline-block; background: #3b82f6; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);">
                View Your Research
              </a>
            </div>
            
            <div style="text-align: center; margin-top: 24px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
              <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
              </p>
            </div>
          </div>
        </div>
      `;
    }
    
    const emailPayload = {
      to: 'kwen1510@hotmail.com',
      subject: subject,
      htmlBody: htmlBody
    };
    
    console.log('📧 Sending email notification...');
    const response = await fetch(APPSCRIPT_EMAIL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload)
    });
    
    if (response.ok) {
      console.log('✅ Email sent successfully');
      return true;
    } else {
      const errorText = await response.text();
      console.error('❌ Email sending failed:', response.status, errorText);
      return false;
    }
  } catch (error) {
    console.error('❌ Error sending email:', error);
    return false;
  }
}

// ========== ONBOARDING ENDPOINTS ==========

// Onboarding chat endpoint with conversation history
app.post('/api/onboarding/chat', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'Missing ANTHROPIC_API_KEY' });
    }
    
    const { conversation } = req.body;
    
    if (!conversation || !Array.isArray(conversation)) {
      return res.status(400).json({ error: 'Invalid conversation format' });
    }
    
    // Log the conversation
    console.log('\n========================================');
    console.log('💬 ONBOARDING CONVERSATION');
    console.log('========================================');
    console.log(`Turn: ${conversation.length}`);
    console.log('\nFull Conversation:');
    conversation.forEach((msg, idx) => {
      console.log(`\n${idx + 1}. [${msg.role.toUpperCase()}]:`);
      console.log(`   ${msg.content}`);
    });
    console.log('\n========================================');
    
    // System prompt for onboarding assistant
    const systemPrompt = `You are an onboarding assistant for a Lesson Analysis tool for teachers. Your role is to:

1. Have a friendly conversation with the teacher about their teaching goals
2. Ask clarifying questions to understand what they want to improve (e.g., student engagement, pacing, questioning techniques, etc.)
3. Once you have enough information (after 2-3 exchanges), suggest that you can do deep research using Manus AI

When you're ready to trigger research, your response should include specific details about what you'll research.

Guidelines:
- Be warm and conversational
- Ask one question at a time
- Show genuine interest in their teaching
- After 2-3 exchanges, if you have clear goals, suggest the research

Keep responses concise (2-3 sentences max).`;
    
    // Build messages array for Claude
    const messages = conversation.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
    
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: systemPrompt,
      messages: messages
    };
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', response.status, errorText);
      return res.status(response.status).json({ error: 'Claude API error', details: errorText });
    }
    
    // Count user messages only
    const userMessageCount = conversation.filter(m => m.role === 'user').length;
    
    // After user sends 2nd message, skip Claude and trigger Manus directly
    if (userMessageCount === 2) {
      console.log('\n🚀 USER SENT 2ND MESSAGE - TRIGGERING MANUS RESEARCH');
      
      // Extract goal from user messages
      const userMessages = conversation.filter(m => m.role === 'user').map(m => m.content);
      const goalText = userMessages.join(' ');
      const researchQuery = `Research teaching strategies for: ${goalText.substring(0, 200)}`;
      
      console.log(`   Query: ${researchQuery}`);
      console.log('========================================\n');
      
      return res.json({
        response: 'Perfect! I have all the information I need. I\'m starting the research now using Manus AI. You\'ll receive an email when the analysis is complete. Feel free to close this page - your results will be saved here.',
        triggerResearch: true,
        researchQuery: researchQuery
      });
    }
    
    // Otherwise, get Claude's response (first turn only)
    const result = await response.json();
    const assistantResponse = result.content[0].text;
    
    console.log('\n📤 Assistant Response:');
    console.log(`   ${assistantResponse}`);
    console.log('========================================\n');
    
    res.json({
      response: assistantResponse,
      triggerResearch: false,
      researchQuery: ''
    });
    
  } catch (error) {
    console.error('Onboarding chat error:', error);
    res.status(500).json({ error: 'Failed to process chat', details: String(error) });
  }
});

// Streaming version of onboarding chat
app.post('/api/onboarding/chat/stream', async (req, res) => {
  try {
    const { conversation } = req.body;
    
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }
    
    console.log('\n========================================');
    console.log('📨 ONBOARDING CHAT REQUEST (Streaming)');
    console.log('Conversation turns:', conversation.length);
    console.log('Full conversation:');
    conversation.forEach((msg, i) => {
      console.log(`   ${i + 1}. ${msg.role}: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`);
    });
    
    // Count user messages only
    const userMessageCount = conversation.filter(m => m.role === 'user').length;
    
    // After user sends 2nd message, skip Claude and trigger Manus directly
    if (userMessageCount === 2) {
      console.log('\n🚀 USER SENT 2ND MESSAGE - TRIGGERING MANUS RESEARCH');
      
      // Extract goal from user messages
      const userMessages = conversation.filter(m => m.role === 'user').map(m => m.content);
      const goalText = userMessages.join(' ');
      const researchQuery = `Research teaching strategies for: ${goalText.substring(0, 200)}`;
      
      console.log(`   Query: ${researchQuery}`);
      console.log('========================================\n');
      
      // Stream the fixed response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const message = 'Perfect! I have all the information I need. I\'m starting the research now using Manus AI. You\'ll receive an email when the analysis is complete. Feel free to close this page - your results will be saved here.';
      
      // Stream the message character by character
      for (let i = 0; i < message.length; i++) {
        res.write(`data: ${JSON.stringify({ content: message[i] })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 20)); // 20ms delay per character
      }
      
      // Send research trigger signal
      res.write(`data: ${JSON.stringify({ triggerResearch: true, researchQuery: researchQuery })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    
    // Otherwise, stream Claude's response (first turn only)
    const systemPrompt = `You are a helpful teaching assistant helping teachers set up their lesson analysis system.

Your role is to:
1. Ask clarifying questions about their teaching goals
2. Understand what they want to improve in their teaching practice
3. Keep responses brief and conversational

This is a 2-turn conversation:
- Turn 1: Ask 2-3 focused clarifying questions about their goals
- Turn 2: The system will automatically trigger research

Be warm, encouraging, and concise.`;
    
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      temperature: 0.7,
      system: systemPrompt,
      messages: conversation,
      stream: true
    };
    
    console.log('\n🤖 Calling Claude API with streaming...');
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', response.status, errorText);
      return res.status(response.status).json({ error: 'Claude API error', details: errorText });
    }
    
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Stream the response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          
          try {
            const parsed = JSON.parse(data);
            
            // Handle different event types
            if (parsed.type === 'content_block_delta') {
              const text = parsed.delta?.text;
              if (text) {
                res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
              }
            } else if (parsed.type === 'message_stop') {
              res.write('data: [DONE]\n\n');
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }
    
    console.log('✅ Streaming complete');
    console.log('========================================\n');
    
    res.end();
    
  } catch (error) {
    console.error('Onboarding streaming chat error:', error);
    res.status(500).json({ error: 'Failed to process chat', details: String(error) });
  }
});

// Trigger Manus research endpoint
app.post('/api/onboarding/trigger-manus', async (req, res) => {
  try {
    const { query, conversation } = req.body;
    
    console.log('\n========================================');
    console.log('🚀 MANUS RESEARCH TRIGGERED');
    console.log('========================================');
    console.log('Query:', query);
    console.log('\nConversation Context:');
    conversation.forEach((msg, idx) => {
      console.log(`${idx + 1}. [${msg.role}]: ${msg.content}`);
    });
    console.log('========================================\n');
    
    // Call Manus API to create research task
    if (!process.env.MANUS_API_KEY) {
      console.warn('⚠️  MANUS_API_KEY not configured, skipping Manus API call');
      return res.json({
        success: true,
        message: 'Manus research logged (API key not configured)',
        query: query,
        timestamp: new Date().toISOString()
      });
    }
    
    // Build full context from conversation
    const conversationText = conversation
      .map(msg => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n\n');
    
    // Create prompt for Manus with explicit request for sources
    // Format conversation to show questions and answers
    const conversationFormatted = conversation
      .map((msg, idx) => {
        if (msg.role === 'user') {
          return `**Teacher's Response ${Math.floor(idx / 2) + 1}:** ${msg.content}`;
        } else {
          return `**My Questions:** ${msg.content}`;
        }
      })
      .join('\n\n');
    
    const fullPrompt = `Research Task: Teaching Strategies

**Context from our conversation:**

${conversationFormatted}

**Your Task:**
Please provide:
1. A brief summary (3-5 bullet points) of the top teaching strategies related to this goal. Keep it concise and actionable.

2. **IMPORTANT**: Create a separate markdown file called "sources_and_references.md" that contains:
   - All academic sources, research papers, and references you used
   - Proper citations with authors, titles, and publication details
   - Links to resources where applicable
   - Educational research studies that support your recommendations

The sources file is essential for the teacher to verify and explore the research further.`;
    
    // Create task in Manus using their API format
    const manusPayload = {
      prompt: fullPrompt,
      taskMode: 'agent',
      // agentProfile: 'quality', // Removed - requires paid plan
      createShareableLink: true,
      hideInTaskList: false
    };
    
    console.log('📤 Sending to Manus API...');
    console.log('Payload:', JSON.stringify(manusPayload, null, 2));
    
    const manusResponse = await fetch('https://api.manus.ai/v1/tasks', {
      method: 'POST',
      headers: {
        'API_KEY': process.env.MANUS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(manusPayload)
    });
    
    if (!manusResponse.ok) {
      const errorText = await manusResponse.text();
      console.error('❌ Manus API error:', manusResponse.status, errorText);
      throw new Error(`Manus API error: ${manusResponse.status}`);
    }
    
    const manusResult = await manusResponse.json();
    console.log('✅ Manus task created:', manusResult);
    console.log('Task ID:', manusResult.task_id);
    console.log('Task URL:', manusResult.task_url);
    console.log('Share URL:', manusResult.share_url);
    
    // Save to Supabase
    if (USE_SUPABASE) {
      try {
        console.log('💾 Saving onboarding session to Supabase...');
        
        // Extract goal text from conversation including questions and answers
        const goalText = conversation
          .map((msg, idx) => {
            if (msg.role === 'user') {
              const responseNum = Math.floor(idx / 2) + 1;
              return `${responseNum}) ${msg.content}`;
            } else {
              return `\nClarifying Questions: ${msg.content}`;
            }
          })
          .join('\n\n');
        
        const sessionPayload = [{
          user_email: 'kwen1510@hotmail.com',
          goal_text: goalText,
          conversation_json: conversation,
          manus_task_id: manusResult.task_id,
          manus_task_url: manusResult.task_url,
          status: 'researching'
        }];
        
        const supabaseResponse = await supabaseRequest('/onboarding_sessions?select=*', {
          method: 'POST',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify(sessionPayload)
        });
        
        if (!supabaseResponse.ok) {
          throw new Error('Failed to save to Supabase');
        }
        
        const savedSession = await supabaseResponse.json();
        console.log('✅ Session saved to Supabase:', savedSession[0]?.id);
      } catch (error) {
        console.error('⚠️ Failed to save to Supabase:', error);
        // Don't fail the request, just log the error
      }
    }
    
    console.log('========================================\n');
    
    res.json({
      success: true,
      message: 'Manus research task created',
      query: query,
      manusTaskId: manusResult.task_id,
      manusTaskUrl: manusResult.task_url,
      manusShareUrl: manusResult.share_url,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Manus trigger error:', error);
    res.status(500).json({ error: 'Failed to trigger Manus', details: String(error) });
  }
});

// Register webhook with Manus (optional - can also be done via dashboard)
app.post('/api/setup/register-manus-webhook', async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    
    if (!process.env.MANUS_API_KEY) {
      return res.status(400).json({ error: 'MANUS_API_KEY not configured' });
    }
    
    if (!webhookUrl) {
      return res.status(400).json({ error: 'webhookUrl is required' });
    }
    
    console.log('📝 Registering webhook with Manus...');
    console.log('Webhook URL:', webhookUrl);
    
    // Note: Manus webhook registration endpoint (check their docs for exact endpoint)
    // This is a placeholder - adjust based on actual Manus webhook API
    const response = await fetch('https://api.manus.ai/v1/webhooks', {
      method: 'POST',
      headers: {
        'API_KEY': process.env.MANUS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: webhookUrl,
        events: ['task_created', 'task_stopped']
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Manus webhook registration failed:', errorText);
      return res.status(response.status).json({ 
        error: 'Failed to register webhook',
        details: errorText 
      });
    }
    
    const result = await response.json();
    console.log('✅ Webhook registered:', result);
    
    res.json({
      success: true,
      message: 'Webhook registered with Manus',
      webhook: result
    });
    
  } catch (error) {
    console.error('❌ Webhook registration error:', error);
    res.status(500).json({ 
      error: 'Failed to register webhook', 
      details: String(error) 
    });
  }
});

// Get latest onboarding session for a user
app.get('/api/onboarding/session/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    if (!USE_SUPABASE) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    console.log('📥 Fetching onboarding session for:', email);
    
    // Get the most recent session for this user
    const response = await supabaseRequest(
      `/onboarding_sessions?user_email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`
    );
    
    if (!response.ok) {
      throw new Error('Failed to fetch from Supabase');
    }
    
    const sessions = await response.json();
    
    if (sessions && sessions.length > 0) {
      console.log('✅ Session found:', sessions[0].id);
      res.json(sessions[0]);
    } else {
      console.log('ℹ️ No session found for this user');
      res.json(null);
    }
    
  } catch (error) {
    console.error('❌ Error fetching session:', error);
    res.status(500).json({ error: 'Failed to fetch session', details: String(error) });
  }
});

// Update an onboarding session
app.put('/api/onboarding/session/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { goal_text, research_output } = req.body;
    
    if (!USE_SUPABASE) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    console.log('💾 Updating session:', id);
    
    const updatePayload = {
      updated_at: new Date().toISOString()
    };
    
    if (goal_text !== undefined) {
      updatePayload.goal_text = goal_text;
    }
    
    if (research_output !== undefined) {
      updatePayload.research_output = research_output;
    }
    
    const response = await supabaseRequest(
      `/onboarding_sessions?id=eq.${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(updatePayload)
      }
    );
    
    if (!response.ok) {
      throw new Error('Failed to update Supabase');
    }
    
    console.log('✅ Session updated successfully');
    res.json({ success: true, message: 'Session updated' });
    
  } catch (error) {
    console.error('❌ Error updating session:', error);
    res.status(500).json({ error: 'Failed to update session', details: String(error) });
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
      'GET /api/flags?sessionId=<sessionId>',
      'POST /api/flags',
      'PUT /api/flags/:id',
      'DELETE /api/flags/:id',
      'POST /api/realtime/transcribe',
      'POST /api/analyze',
      'POST /api/analyze/stream',
      'POST /api/webhook/manus',
      'POST /api/onboarding/chat',
      'POST /api/onboarding/chat/stream',
      'POST /api/onboarding/trigger-manus',
      'POST /api/setup/register-manus-webhook',
      'GET /api/onboarding/session/:email',
      'PUT /api/onboarding/session/:id'
    ]
  });
});

app.listen(PORT, () => {
  console.log(`Express server running: http://localhost:${PORT}`);
});
