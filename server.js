const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();
const { Groq } = require('groq-sdk');
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const archiver = require('archiver');
const app = express();

// Initialize Groq client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Initialize ElevenLabs client
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

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
  const response = await supabaseRequest(`/lessons?session_id=eq.${sessionId}&select=id,session_id,title,uploaded_at,transcript_content,transcript_file,analysis,pedagogy_analysis`);
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
    transcript_content: Array.isArray(obj.transcript) ? obj.transcript : [],
    pedagogy_analysis: obj.pedagogy_analysis || null
  };
}

const PORT = 3000;
const PROMPTS_DIR = path.join(__dirname, 'PROMPTS');

// PWA: Explicit MIME types for manifest and service worker
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/favicon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.sendFile(path.join(__dirname, 'favicon.svg'));
});

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

// Pedagogy analysis endpoint
app.get('/api/pedagogy', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }
    
    if (USE_SUPABASE) {
      // Fetch from Supabase - include transcript_content and word_transcript
      const response = await supabaseRequest(`/lessons?session_id=eq.${sessionId}&select=pedagogy_analysis,transcript_content,word_transcript`);
      const lessons = await response.json();
      if (lessons.length === 0) {
        return res.status(404).json({ error: 'Lesson not found' });
      }
      return res.json({ 
        pedagogy_analysis: lessons[0].pedagogy_analysis || null,
        transcript: lessons[0].transcript_content || [],
        wordTranscript: lessons[0].word_transcript || null
      });
    } else {
      // Fetch from local file
      const lesson = await getLocalLessonBySessionId(sessionId);
      if (!lesson) {
        return res.status(404).json({ error: 'Lesson not found' });
      }
      
      // Load word transcript from TRANSCRIPTS folder
      let wordTranscript = null;
      try {
        const wordTranscriptPath = path.join(__dirname, '../Phase_1_Extract_Transcript/TRANSCRIPTS', `${sessionId}_transcript.json`);
        if (fs.existsSync(wordTranscriptPath)) {
          wordTranscript = JSON.parse(fs.readFileSync(wordTranscriptPath, 'utf-8'));
        }
      } catch (e) {
        console.error('Error loading word transcript:', e);
      }
      
      return res.json({ 
        pedagogy_analysis: lesson.pedagogy_analysis || null,
        transcript: lesson.transcript || [],
        wordTranscript: wordTranscript
      });
    }
  } catch (e) {
    console.error('Error fetching pedagogy analysis:', e);
    res.status(500).json({ error: 'Could not fetch pedagogy analysis' });
  }
});

// Pedagogy preferences endpoints
app.get('/api/pedagogy/preferences', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }
    
    if (USE_SUPABASE) {
      const response = await supabaseRequest(`/onboarding_sessions?select=pedagogy_preferences&email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`);
      const data = await response.json();
      
      if (data && data.length > 0 && data[0].pedagogy_preferences) {
        return res.json({ preferences: data[0].pedagogy_preferences });
      }
    }
    
    // Return null if not found, frontend will use defaults
    res.json({ preferences: null });
  } catch (e) {
    console.error('Error fetching pedagogy preferences:', e);
    res.status(500).json({ error: 'Could not fetch preferences' });
  }
});

app.post('/api/pedagogy/preferences', async (req, res) => {
  try {
    const { email, preferences } = req.body;
    if (!email || !preferences) {
      return res.status(400).json({ error: 'Email and preferences required' });
    }
    
    if (USE_SUPABASE) {
      // Update the most recent onboarding session for this email
      const getResponse = await supabaseRequest(`/onboarding_sessions?select=id&email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`);
      const sessions = await getResponse.json();
      
      if (sessions && sessions.length > 0) {
        const sessionId = sessions[0].id;
        await supabaseRequest(`/onboarding_sessions?id=eq.${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pedagogy_preferences: preferences })
        });
        
        return res.json({ success: true });
      }
    }
    
    res.json({ success: true, note: 'Saved locally only' });
  } catch (e) {
    console.error('Error saving pedagogy preferences:', e);
    res.status(500).json({ error: 'Could not save preferences' });
  }
});

// Progress tracking endpoint
app.get('/api/progress', async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    let lessons = [];
    
    if (USE_SUPABASE) {
      let query = '/lessons?select=session_id,title,uploaded_at,analysis,pedagogy_analysis,transcript_content&order=uploaded_at.desc';
      
      // Add date filters if provided
      if (fromDate && toDate) {
        // Supabase date filtering: gte (greater than or equal), lte (less than or equal)
        query += `&uploaded_at=gte.${fromDate}T00:00:00&uploaded_at=lte.${toDate}T23:59:59`;
      }
      
      const response = await supabaseRequest(query);
      lessons = await response.json();
    } else {
      lessons = await getLocalLessons();
      
      // Apply date filtering for local files
      if (fromDate && toDate) {
        const from = new Date(fromDate);
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999); // Include entire end date
        
        lessons = lessons.filter(lesson => {
          const uploadDate = new Date(lesson.uploadedAt || lesson.uploaded_at);
          return uploadDate >= from && uploadDate <= to;
        });
      }
    }
    
    // Extract metrics from each lesson
    const lessonsWithMetrics = lessons.map(lesson => {
      const pedagogy = lesson.pedagogy_analysis || {};
      const waitTimes = pedagogy.wait_time_analysis || {};
      const questionSummary = pedagogy.question_analysis?.summary || {};
      const analysis = lesson.analysis || {};
      const transcript = lesson.transcript_content || lesson.transcript || [];
      
      // Calculate teacher talk percentage from transcript
      let teacherTime = 0;
      let studentTime = 0;
      transcript.forEach(seg => {
        const duration = (seg.end || 0) - (seg.start || 0);
        if (seg.role === 'TEACHER') teacherTime += duration;
        else if (seg.role === 'STUDENT') studentTime += duration;
      });
      const totalTime = teacherTime + studentTime;
      const teacherTalkPercent = totalTime > 0 ? Math.round((teacherTime / totalTime) * 100) : 0;
      
      return {
        sessionId: lesson.session_id || lesson.sessionId,
        title: lesson.title || 'Untitled',
        uploadedAt: lesson.uploaded_at || lesson.uploadedAt,
        teacherTalkPercent: teacherTalkPercent,
        avgWaitTime: waitTimes.average || 0,
        totalQuestions: questionSummary.total_questions_analyzed || 0,
        feedback: analysis.summary || ''
      };
    });
    
    // Don't auto-generate report - user will request it separately
    res.json({
      lessons: lessonsWithMetrics
    });
  } catch (error) {
    console.error('Error fetching progress:', error);
    res.status(500).json({ error: 'Could not fetch progress data' });
  }
});

// Generate AI Progress Report (on-demand)
app.post('/api/progress/generate-report', async (req, res) => {
  try {
    const { lessons, fromDate, toDate } = req.body;
    
    if (!lessons || lessons.length === 0) {
      return res.json({ report: 'No lessons available for analysis. Upload lessons to get started!' });
    }
    
    console.log(`🤖 Generating AI progress report for ${lessons.length} lessons...`);
    
    // Use Claude to generate the progress report
    const report = await generateProgressReportWithClaude(lessons, fromDate, toDate);
    
    res.json({ report });
  } catch (error) {
    console.error('Error generating progress report:', error);
    res.status(500).json({ error: 'Failed to generate progress report' });
  }
});

// Answer specific questions about teaching progress
app.post('/api/progress/ask-question', async (req, res) => {
  try {
    const { question, lessons, fromDate, toDate, includeGoals } = req.body;
    
    if (!question || !lessons || lessons.length === 0) {
      return res.json({ answer: 'No question or lessons provided.' });
    }
    
    console.log(`💬 Answering question: "${question}" for ${lessons.length} lessons...`);
    
    // Fetch goals and research if requested
    let goalsData = null;
    if (includeGoals && USE_SUPABASE) {
      try {
        console.log('📚 Fetching teaching goals and research from Supabase...');
        const goalsResponse = await supabaseRequest('/onboarding_sessions?select=goal_text,research_output,research_sources&order=created_at.desc&limit=1');
        const sessions = await goalsResponse.json();
        console.log('📊 Onboarding sessions found:', sessions.length);
        
        if (sessions && sessions.length > 0) {
          const session = sessions[0];
          
          // Fetch actual markdown content from research_sources URLs
          let researchContent = '';
          if (session.research_sources && Array.isArray(session.research_sources)) {
            console.log(`📄 Fetching ${session.research_sources.length} research markdown files...`);
            
            const markdownPromises = session.research_sources.map(async (source) => {
              try {
                const url = source.url || source;
                const response = await fetch(url);
                if (response.ok) {
                  const text = await response.text();
                  return `\n## ${source.title || 'Research Document'}\n\n${text}\n`;
                }
              } catch (err) {
                console.log(`⚠️ Could not fetch research file: ${source.title || source}`);
              }
              return '';
            });
            
            const markdownContents = await Promise.all(markdownPromises);
            researchContent = markdownContents.filter(c => c).join('\n---\n');
            console.log(`✅ Loaded ${markdownContents.filter(c => c).length} research documents`);
          }
          
          goalsData = {
            goals: session.goal_text || 'Not specified',
            researchSummary: session.research_output || 'Not specified',
            researchContent: researchContent || 'No research materials loaded'
          };
          
          console.log('✅ Goals loaded:', session.goal_text || 'None');
          console.log('✅ Research summary loaded:', session.research_output ? 'Yes' : 'No');
          console.log('✅ Research documents loaded:', researchContent ? 'Yes' : 'No');
        } else {
          console.log('⚠️ No onboarding sessions found');
        }
      } catch (e) {
        console.error('❌ Could not fetch goals:', e.message);
      }
    }
    
    // Use Groq to answer the specific question
    const answer = await answerProgressQuestion(question, lessons, fromDate, toDate, goalsData);
    
    res.json({ answer });
  } catch (error) {
    console.error('Error answering question:', error);
    res.status(500).json({ error: 'Failed to answer question' });
  }
});

async function generateProgressReportWithClaude(lessons, fromDate = null, toDate = null) {
  if (lessons.length === 0) return '';
  
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set - cannot generate AI report');
    return 'AI report generation requires API key configuration.';
  }
  
  // Format date range
  let dateRangeText = '';
  if (fromDate && toDate) {
    const formatDate = (dateStr) => new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    dateRangeText = ` from ${formatDate(fromDate)} to ${formatDate(toDate)}`;
  }
  
  // Prepare lesson data summary for Claude
  const lessonsSummary = lessons.map((lesson, idx) => ({
    number: idx + 1,
    title: lesson.title,
    date: new Date(lesson.uploadedAt).toLocaleDateString(),
    teacherTalkPercent: lesson.teacherTalkPercent,
    avgWaitTime: lesson.avgWaitTime,
    totalQuestions: lesson.totalQuestions,
    feedback: lesson.feedback ? lesson.feedback.substring(0, 200) : 'N/A'
  }));
  
  const prompt = `You are an expert educational coach analyzing a teacher's progress over time. 

Your task is to analyze the teaching metrics from ${lessons.length} lesson${lessons.length > 1 ? 's' : ''}${dateRangeText} and provide an encouraging, actionable progress report.

Key metrics to analyze:
- **Wait Time**: Time teacher pauses after asking questions (optimal: 3-5 seconds)
- **Teacher Talk %**: Percentage of lesson time teacher speaks (balance needed: give students voice while providing instruction)
- **Total Questions**: Number of questions asked (indicates engagement)

Here's the lesson data:
${JSON.stringify(lessonsSummary, null, 2)}

Please provide:
1. **Overall Progress Summary**: Brief opening about their teaching journey${lessons.length > 1 ? ', comparing first to most recent lesson' : ''}
2. **Wait Time Analysis**: Comment on wait time trends and provide research-backed guidance
3. **Student Voice**: Analyze teacher talk % and balance with student participation  
4. **Engagement**: Comment on questioning patterns
5. **Next Steps**: 1-2 specific, actionable recommendations

Keep the tone:
- Encouraging and supportive
- Evidence-based (cite research where appropriate)
- Specific to their data
- Actionable and practical
- Concise (250-350 words total)

Format with **bold headers** for each section. Write in second person ("You..."). Do NOT use bullet points in the output - write in flowing paragraphs.`;

  try {
    const payload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1500,
      temperature: 0.7,
      system: 'You are an expert educational coach who provides encouraging, evidence-based feedback to help teachers improve their practice.',
      messages: [
        { role: 'user', content: prompt }
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

    if (!resp.ok) {
      throw new Error(`Anthropic API error: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    const report = data.content?.[0]?.text || 'Unable to generate report.';
    
    console.log('✅ AI progress report generated successfully');
    return report;
    
  } catch (error) {
    console.error('❌ Error calling Claude API:', error);
    // Fallback to basic report if Claude fails
    return `Analysis of ${lessons.length} lesson${lessons.length > 1 ? 's' : ''}${dateRangeText}:\n\nAverage wait time: ${(lessons.reduce((sum, l) => sum + (l.avgWaitTime || 0), 0) / lessons.length).toFixed(1)}s\nAverage teacher talk: ${Math.round(lessons.reduce((sum, l) => sum + (l.teacherTalkPercent || 0), 0) / lessons.length)}%\nTotal questions asked: ${lessons.reduce((sum, l) => sum + (l.totalQuestions || 0), 0)}\n\n(AI analysis temporarily unavailable - showing basic metrics)`;
  }
}

async function answerProgressQuestion(question, lessons, fromDate = null, toDate = null, goalsData = null) {
  if (lessons.length === 0) return 'No lessons available for analysis.';
  
  if (!process.env.GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY not set');
    return 'AI analysis requires API key configuration.';
  }
  
  // Format date range
  let dateRangeText = '';
  if (fromDate && toDate) {
    const formatDate = (dateStr) => new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    dateRangeText = ` from ${formatDate(fromDate)} to ${formatDate(toDate)}`;
  }
  
  // Prepare lesson data summary
  const lessonsSummary = lessons.map((lesson, idx) => ({
    number: idx + 1,
    title: lesson.title,
    date: new Date(lesson.uploadedAt).toLocaleDateString(),
    teacherTalkPercent: lesson.teacherTalkPercent,
    avgWaitTime: lesson.avgWaitTime,
    totalQuestions: lesson.totalQuestions,
    feedback: lesson.feedback ? lesson.feedback.substring(0, 200) + '...' : null
  }));
  
  // Build prompt with optional goals and teaching plan
  let prompt = `You are an expert educational coach analyzing a teacher's progress${dateRangeText}.

**Teacher's Question:** ${question}

**Lesson Data (${lessons.length} lesson${lessons.length > 1 ? 's' : ''}):**
${JSON.stringify(lessonsSummary, null, 2)}`;

  // Add goals and research materials if provided
  if (goalsData) {
    prompt += `

**Teacher's Stated Goals:**
${goalsData.goals || 'Not specified'}

**Research Summary (AI-generated during onboarding):**
${goalsData.researchSummary || 'Not specified'}

**Research-Backed Teaching Strategies (from selected research documents):**
${goalsData.researchContent ? goalsData.researchContent.substring(0, 3000) : 'Not specified'}
`;
  }

  prompt += `

**Context About Metrics:**
- **Wait Time**: Time teacher pauses after asking questions before accepting responses (optimal: 3-5 seconds according to research)
- **Teacher Talk %**: Percentage of lesson time teacher speaks (balance needed: give students voice while providing instruction)
- **Total Questions**: Number of questions asked (indicates engagement and formative assessment)

Please provide a focused, helpful answer to the teacher's question based on their actual data${goalsData ? ', their stated goals, and the research-backed strategies from their selected materials' : ''}. Be:
- **Specific**: Reference their actual numbers and trends${goalsData ? ' in relation to their stated goals' : ''}
- **Evidence-based**: ${goalsData ? 'Cite specific research from the materials they selected during onboarding' : 'Cite research where relevant'}
- **Personalized**: ${goalsData ? 'Connect your feedback directly to what THEY said they wanted to achieve and the research THEY chose to focus on' : 'Provide general best practices'}
- **Actionable**: Provide concrete next steps that align with their research materials
- **Encouraging**: Frame feedback positively while being honest
- **Concise**: Keep response to 250-350 words

Format with **bold** for key points. Write in second person ("You..."). Use a conversational, supportive tone.`;

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are an expert educational coach who provides specific, evidence-based, and encouraging feedback to help teachers improve their practice. You have access to mathematical tools when you need to calculate statistics or perform numerical analysis."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      model: "openai/gpt-oss-120b",
      temperature: 0.7,
      max_completion_tokens: 2000,
      top_p: 1,
      reasoning_effort: "medium"
    });
    
    const answer = chatCompletion.choices[0]?.message?.content || 'Unable to generate answer.';
    
    console.log('✅ AI answer generated successfully (Groq OSS-120B)');
    return answer;
    
  } catch (error) {
    console.error('❌ Error calling Groq API:', error);
    return `I'm having trouble analyzing your data right now. Here's what I can see from ${lessons.length} lesson${lessons.length > 1 ? 's' : ''}:\n\nAverage wait time: ${(lessons.reduce((sum, l) => sum + (l.avgWaitTime || 0), 0) / lessons.length).toFixed(1)}s\nAverage teacher talk: ${Math.round(lessons.reduce((sum, l) => sum + (l.teacherTalkPercent || 0), 0) / lessons.length)}%\nTotal questions: ${lessons.reduce((sum, l) => sum + (l.totalQuestions || 0), 0)}`;
  }
}

// Simple raw-audio transcription endpoint for Groq Whisper  
app.post('/api/realtime/transcribe', express.raw({ type: ['application/octet-stream', 'audio/webm', 'audio/wav'], limit: '25mb' }), async (req, res) => {
  try {
    console.log('🎤 Groq Whisper request received');
    console.log('   Content-Type:', req.headers['content-type']);
    console.log('   Body length:', req.body ? req.body.length : 0);
    
    if (!process.env.GROQ_API_KEY) {
      console.error('❌ Missing GROQ_API_KEY');
      return res.status(400).json({ error: 'Missing GROQ_API_KEY' });
    }
    
    // Verify API key is present
    const keyPreview = process.env.GROQ_API_KEY.substring(0, 10) + '...';
    console.log('   API Key:', keyPreview);
    
    const audioBuffer = req.body;
    
    // Check if we have valid audio data
    if (!audioBuffer || audioBuffer.length === 0) {
      console.error('❌ No audio data received');
      return res.status(400).json({ error: 'No audio data received' });
    }
    
    console.log('✅ Audio data valid, sending to Groq...');
    
    // Save audio to temp file for Groq SDK
    const tempFilePath = path.join(os.tmpdir(), `groq_audio_${Date.now()}.webm`);
    fs.writeFileSync(tempFilePath, audioBuffer);
    
    console.log('📡 Sending to Groq API via SDK...');
    
    try {
      // Use Groq SDK for transcription
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: 'whisper-large-v3-turbo',
        response_format: 'json'
      });
      
      // Clean up temp file
      fs.unlinkSync(tempFilePath);
      
      const transcriptionText = transcription.text || '';
      console.log(`✅ Groq transcription (${transcriptionText.length} chars):`, transcriptionText.substring(0, 100));
      
      res.json({ text: transcriptionText });
      
    } catch (transcriptionError) {
      // Clean up temp file on error
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch (cleanupError) {
        console.warn('⚠️  Could not clean up temp file:', cleanupError.message);
      }
      throw transcriptionError;
    }
    
  } catch (error) {
    console.error('❌ Groq Whisper API error:', error);
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
      to: process.env.TEACHER_EMAIL || 'your-email@example.com',
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
          user_email: process.env.TEACHER_EMAIL || 'user@example.com',
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

// ========== RECORDING ENDPOINTS ==========

// Setup multer for file uploads
const RECORDINGS_DIR = path.join(__dirname, 'RECORDINGS');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

const upload = multer({ dest: path.join(RECORDINGS_DIR, 'temp') });

// ElevenLabs API key
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Store transcripts by session
const sessionTranscripts = {};

// Periodic cleanup job - delete sessions older than 7 days
function cleanupOldRecordings() {
  try {
    if (!fs.existsSync(RECORDINGS_DIR)) return;
    
    const sessions = fs.readdirSync(RECORDINGS_DIR).filter(f => 
      f.startsWith('lesson_') && fs.statSync(path.join(RECORDINGS_DIR, f)).isDirectory()
    );
    
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let deletedCount = 0;
    
    sessions.forEach(session => {
      const sessionPath = path.join(RECORDINGS_DIR, session);
      const stat = fs.statSync(sessionPath);
      
      if (stat.mtimeMs < sevenDaysAgo) {
        // Delete old session
        fs.rmSync(sessionPath, { recursive: true, force: true });
        deletedCount++;
        console.log(`🗑️  Deleted old recording session: ${session}`);
      }
    });
    
    if (deletedCount > 0) {
      console.log(`🧹 Cleanup complete: Deleted ${deletedCount} old session(s)`);
    }
  } catch (error) {
    console.error('❌ Cleanup error:', error);
  }
}

// Run cleanup every 24 hours
setInterval(cleanupOldRecordings, 24 * 60 * 60 * 1000);
// Run cleanup on startup
setTimeout(cleanupOldRecordings, 5000);

// POST /api/recording/transcribe-chunk
// Receives audio chunk, transcribes via ElevenLabs, returns transcript
app.post('/api/recording/transcribe-chunk', upload.single('audio'), async (req, res) => {
  try {
    const { sessionId, chunkNumber, isFinal, mimeType } = req.body;
    const audioFile = req.file;
    
    if (!audioFile) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }
    
    if (!ELEVENLABS_API_KEY) {
      console.log('⚠️ ELEVENLABS_API_KEY not set, skipping transcription');
      return res.json({ 
        success: true, 
        transcript: null, 
        message: 'Transcription skipped (no API key)' 
      });
    }
    
    console.log(`📥 Received chunk ${chunkNumber} for session ${sessionId} (${audioFile.size} bytes)`);
    
    // Create session directory
    const sessionDir = path.join(RECORDINGS_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    // Save chunk with proper extension
    const extension = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'webm';
    const chunkPath = path.join(sessionDir, `chunk_${chunkNumber}.${extension}`);
    fs.renameSync(audioFile.path, chunkPath);
    
    // Transcribe with ElevenLabs (using axios - works better with multipart form-data)
    try {
      console.log(`🔊 Transcribing chunk ${chunkNumber} with ElevenLabs...`);
      
      // Create FormData with file stream
      const formData = new FormData();
      formData.append('file', fs.createReadStream(chunkPath), {
        filename: `chunk_${chunkNumber}.${extension}`,
        contentType: `audio/${extension}`
      });
      formData.append('model_id', 'scribe_v1');  // Using scribe_v1 model
      
      // Use axios with FormData (handles multipart correctly)
      const response = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', formData, {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          ...formData.getHeaders()
        }
      });
      
      console.log(`📡 ElevenLabs response status: ${response.status}`);
      
      const data = response.data;
      const transcript = data.text || '';
      console.log(`📥 ElevenLabs transcription for chunk ${chunkNumber}:`, JSON.stringify(data, null, 2));
      console.log(`✅ Chunk ${chunkNumber} transcribed (${transcript.length} chars): ${transcript.substring(0, 100)}...`);
      
      // Keep audio chunk for download (don't delete yet)
      // Chunks will be cleaned up by the periodic cleanup job or after download
      console.log(`💾 Keeping chunk ${chunkNumber} audio file for download`);
      
      // Store transcript
      if (!sessionTranscripts[sessionId]) {
        sessionTranscripts[sessionId] = [];
      }
      sessionTranscripts[sessionId].push({
        chunkNumber: parseInt(chunkNumber),
        transcript: transcript
      });
      
      // Sort by chunk number to ensure correct order
      sessionTranscripts[sessionId].sort((a, b) => a.chunkNumber - b.chunkNumber);
      
      // If final chunk, save combined transcript and clean up temp directory
      if (isFinal === 'true') {
        const fullTranscript = sessionTranscripts[sessionId].map(t => t.transcript).join(' ');
        fs.writeFileSync(
          path.join(sessionDir, 'transcript.txt'),
          fullTranscript
        );
        console.log(`💾 Final transcript saved for session ${sessionId}`);
        
        // Clean up temp directory
        const tempDir = path.join(RECORDINGS_DIR, 'temp');
        if (fs.existsSync(tempDir)) {
          const tempFiles = fs.readdirSync(tempDir);
          tempFiles.forEach(file => {
            try {
              fs.unlinkSync(path.join(tempDir, file));
            } catch (err) {
              console.warn(`⚠️  Could not delete temp file ${file}`);
            }
          });
        }
        
        // Clean up session transcript from memory
        delete sessionTranscripts[sessionId];
        console.log(`🧹 Cleaned up session ${sessionId} from memory`);
      }
      
      res.json({
        success: true,
        transcript: transcript,
        chunkNumber: parseInt(chunkNumber)
      });
      
    } catch (transcribeError) {
      console.error('❌ Transcription error:', transcribeError);
      // Keep the audio file for potential retry
      console.log(`💾 Keeping chunk ${chunkNumber} audio file for retry`);
      res.json({
        success: false,
        error: transcribeError.message,
        transcript: null
      });
    }
    
  } catch (error) {
    console.error('❌ Chunk processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/recording/download/:sessionId
// Downloads the audio file (serves individual chunk or combined file)
app.get('/api/recording/download/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionDir = path.join(RECORDINGS_DIR, sessionId);
    
    if (!fs.existsSync(sessionDir)) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    
    // Find all chunks
    const files = fs.readdirSync(sessionDir);
    const chunks = files
      .filter(f => f.startsWith('chunk_'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/chunk_(\d+)/)[1]);
        const numB = parseInt(b.match(/chunk_(\d+)/)[1]);
        return numA - numB;
      });
    
    if (chunks.length === 0) {
      return res.status(404).json({ error: 'No audio chunks found' });
    }
    
    console.log(`📥 Downloading ${chunks.length} chunk(s) for session: ${sessionId}`);
    
    // If only one chunk, serve it directly (most common case)
    if (chunks.length === 1) {
      const chunkPath = path.join(sessionDir, chunks[0]);
      const ext = path.extname(chunks[0]);
      const contentType = ext === '.webm' ? 'audio/webm' : 'audio/mpeg';
      
      res.setHeader('Content-Disposition', `attachment; filename="Lesson_${sessionId}${ext}"`);
      res.setHeader('Content-Type', contentType);
      
      const fileStream = fs.createReadStream(chunkPath);
      fileStream.pipe(res);
      
      fileStream.on('end', () => {
        console.log(`✅ Download complete: ${chunks[0]}`);
      });
      
      return;
    }
    
    // For multiple chunks, create a simple ZIP file with all chunks
    // This is more reliable than trying to merge WebM files
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 0 } }); // No compression for audio
    
    const zipFilename = `Lesson_${sessionId}_${chunks.length}chunks.zip`;
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
    res.setHeader('Content-Type', 'application/zip');
    
    archive.pipe(res);
    
    // Add all chunks to the ZIP
    chunks.forEach((chunkFile) => {
      const chunkPath = path.join(sessionDir, chunkFile);
      archive.file(chunkPath, { name: chunkFile });
    });
    
    // Add transcript if available
    const transcriptPath = path.join(sessionDir, 'transcript.txt');
    if (fs.existsSync(transcriptPath)) {
      archive.file(transcriptPath, { name: 'transcript.txt' });
    }
    
    archive.finalize();
    
    archive.on('end', () => {
      console.log(`✅ Download complete: ${chunks.length} chunks in ZIP`);
    });
    
  } catch (error) {
    console.error('❌ Download error:', error);
    
    // Fallback: serve first chunk only
    const sessionDir = path.join(RECORDINGS_DIR, req.params.sessionId);
    const files = fs.readdirSync(sessionDir);
    const firstChunk = files.find(f => f.startsWith('chunk_'));
    
    if (firstChunk) {
      const chunkPath = path.join(sessionDir, firstChunk);
      const ext = path.extname(firstChunk);
      res.setHeader('Content-Disposition', `attachment; filename="Lesson${ext}"`);
      res.setHeader('Content-Type', ext === '.webm' ? 'audio/webm' : 'audio/mpeg');
      fs.createReadStream(chunkPath).pipe(res);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ========== END RECORDING ENDPOINTS ==========

app.listen(PORT, () => {
  console.log(`Express server running: http://localhost:${PORT}`);
});
