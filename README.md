# Panopto Lesson Viewer

A web application for viewing educational videos with AI-powered lesson analysis and interactive timestamps.

## Features

- **Video Player**: Panopto video integration with seek controls
- **Interactive Timestamps**: Click to jump to specific moments in the lesson
- **AI Assistant**: Ask questions about the lesson content with voice input
- **Real-time Transcription**: Voice-to-text using Groq Whisper
- **Lesson Analysis**: AI-powered insights using Claude Sonnet

## Tech Stack

- **Frontend**: HTML, CSS (Tailwind), JavaScript
- **Backend**: Node.js, Express.js
- **Database**: Supabase (PostgreSQL)
- **AI Services**: Groq (Whisper), Anthropic (Claude)

## Deployment on Render

### 1. Prerequisites

- Supabase project with database tables
- Groq API key
- Anthropic API key

### 2. Environment Variables

Copy `env.example` to `.env` and fill in your values:

```bash
cp env.example .env
```

Required variables:
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_KEY`: Your Supabase anon key
- `GROQ_API_KEY`: Your Groq API key
- `ANTHROPIC_API_KEY`: Your Anthropic API key

### 3. Database Setup

Run the SQL in your Supabase SQL Editor:

```sql
-- Create tables
CREATE TABLE IF NOT EXISTS lessons (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    transcript_file TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcripts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
    speaker TEXT NOT NULL,
    start_time DECIMAL NOT NULL,
    end_time DECIMAL NOT NULL,
    text TEXT NOT NULL,
    role TEXT DEFAULT 'STUDENT',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
    user_message TEXT NOT NULL,
    ai_response TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_transcripts_lesson_id ON transcripts(lesson_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_start_time ON transcripts(start_time);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_lesson_id ON chat_sessions(lesson_id);

-- Enable RLS
ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Allow all operations on lessons" ON lessons FOR ALL USING (true);
CREATE POLICY "Allow all operations on transcripts" ON transcripts FOR ALL USING (true);
CREATE POLICY "Allow all operations on chat_sessions" ON chat_sessions FOR ALL USING (true);
```

### 4. Upload Data

Use `01_push_to_supabase.py` to upload your transcript data:

```bash
python 01_push_to_supabase.py
```

### 5. Deploy to Render

1. Connect your GitHub repository to Render
2. Create a new Web Service
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variables in Render dashboard
6. Deploy!

## Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Server runs on http://localhost:3000
```

## API Endpoints

- `GET /api/video-metadata` - Get available lessons
- `GET /api/timestamps?sessionId=<id>` - Get lesson timestamps
- `GET /api/lesson/:sessionId` - Get complete lesson data
- `POST /api/realtime/transcribe` - Voice transcription
- `POST /api/analyze` - AI lesson analysis
- `POST /api/analyze/stream` - Streaming AI analysis

## Usage

1. Select a lesson from the dropdown
2. Click timestamps to seek in the video
3. Switch to Assistant tab for AI chat
4. Use voice input for hands-free interaction

## File Structure

```
├── index.html              # Main frontend
├── server.js               # Express server
├── package.json            # Dependencies
├── VIDEO_METADATA/         # Prompt templates
├── TRANSCRIPT/             # Sample transcript files
├── 01_push_to_supabase.py  # Data upload script
└── env.example             # Environment template
```
