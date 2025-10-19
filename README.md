# 🎓 Lesson Analysis Assistant - Ready to Deploy

AI-powered lesson recording and analysis assistant with real-time transcription.

## 🚀 Quick Deploy

### Deploy to Render.com (Recommended - Free Tier Available)

1. **Fork/Upload this repository to GitHub**

2. **Go to [render.com](https://render.com) and create account**

3. **Create New Web Service:**
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Or select "Deploy from GitHub"

4. **Configure:**
   ```
   Name: lesson-analysis-assistant
   Environment: Node
   Build Command: npm install
   Start Command: npm start
   ```

5. **Add Environment Variables:**
   ```
   ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
   GROQ_API_KEY=your_groq_api_key_here (optional)
   ANTHROPIC_API_KEY=your_anthropic_key_here (optional)
   ```

6. **Deploy!** Render will automatically build and deploy

7. **Access your app at:** `https://your-app-name.onrender.com`

---

## 🔑 Required Environment Variables

### Essential (for core features):
- **`ELEVENLABS_API_KEY`** - For speech-to-text transcription
  - Get at: https://elevenlabs.io
  - Required for recording & transcription

### Optional (for enhanced features):
- **`GROQ_API_KEY`** - For alternative transcription (Groq Whisper)
- **`ANTHROPIC_API_KEY`** - For AI lesson analysis
- **`SUPABASE_URL`** - For lesson storage
- **`SUPABASE_KEY`** - For lesson storage

---

## 📦 What's Included

```
DEPLOY/
├── index.html          # Main application UI
├── server.js           # Backend API server
├── sw.js              # Service worker (PWA)
├── manifest.json      # PWA manifest
├── package.json       # Dependencies
├── render.yaml        # Render config
├── env.example        # Environment template
├── favicon.svg        # App icon
├── icons/             # PWA icons
└── PROMPTS/           # AI prompts
```

---

## ✨ Features

- **🎤 Recording** - Record lessons with live transcription
- **📝 Transcription** - Automatic speech-to-text (ElevenLabs)
- **⬇️ Download** - Single file for short recordings, ZIP for long sessions
- **📊 Analysis** - AI-powered lesson insights
- **📈 Progress Tracking** - Monitor teaching patterns
- **💾 Offline Support** - PWA works offline
- **📱 Mobile Ready** - Installable on phones/tablets

---

## 🛠️ Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp env.example .env
# Edit .env and add your API keys

# Start server
npm start

# Open browser
open http://localhost:3000
```

---

## 🌐 Other Deployment Options

### Railway
```bash
railway login
railway init
railway up
```
Set environment variables in Railway dashboard.

### Heroku
```bash
heroku create your-app-name
heroku config:set ELEVENLABS_API_KEY=your_key_here
git push heroku main
```

### Fly.io
```bash
fly launch
fly secrets set ELEVENLABS_API_KEY=your_key_here
fly deploy
```

---

## 🔒 Security Notes

- ✅ API keys stored server-side only
- ✅ Never commit `.env` to version control
- ✅ HTTPS required for microphone access in production
- ✅ Service worker caches static assets only

---

## 📱 PWA Installation

After deploying:
1. Visit your deployed URL
2. Look for "Install App" prompt in browser
3. Click to install as standalone app
4. Launch from home screen/app menu

---

## 🐛 Troubleshooting

### Deployment fails
- Check all environment variables are set
- Verify `ELEVENLABS_API_KEY` is valid
- Check build logs for errors

### Recording doesn't work
- Ensure HTTPS is enabled (required for microphone)
- Check browser permissions for microphone
- Verify `ELEVENLABS_API_KEY` is set correctly

### Transcription fails
- Check ElevenLabs API credits
- Verify API key has permissions
- Check server logs for errors

---

## 📊 System Requirements

### Server:
- Node.js 18+
- 512MB RAM minimum
- HTTPS enabled

### Client:
- Modern browser (Chrome, Safari, Firefox, Edge)
- Microphone access
- Internet connection (for transcription)

---

## 💡 Usage Tips

1. **Recording Quality:**
   - Speak clearly and close to microphone
   - Minimize background noise
   - Use headphones to avoid feedback

2. **Transcript Accuracy:**
   - Longer recordings = better accuracy
   - Pause briefly between sentences
   - Speak in complete thoughts

3. **Performance:**
   - App caches for offline use
   - Transcripts save locally in browser
   - Download recordings after completion

---

## 🎯 Core Features Ready

- ✅ **Recording & Transcription** - Fully working
- ✅ **Lesson Analysis** - AI-powered insights
- ✅ **Progress Tracking** - Teaching patterns
- ✅ **PWA Support** - Installable app
- ✅ **Offline Mode** - Service worker caching
- ✅ **Mobile Optimized** - Responsive design

---

## 📝 Post-Deployment

After deploying, test these features:

1. **Recording:**
   - Navigate to "Record" tab
   - Start a test recording
   - Verify transcription appears

2. **PWA Installation:**
   - Check for install prompt
   - Install and launch as app

3. **Offline Mode:**
   - Disconnect internet
   - App should still load
   - Recording saves locally

---

## 🆘 Support

For issues or questions:
- Check server logs in hosting dashboard
- Review browser console for errors
- Verify environment variables are set
- Test with simple 5-second recording first

---

## 🎉 You're Ready!

This app is production-ready and tested. Simply:
1. Set `ELEVENLABS_API_KEY` environment variable
2. Deploy to your chosen platform
3. Test recording feature
4. Share with users!

**Estimated deployment time: 5-10 minutes**

