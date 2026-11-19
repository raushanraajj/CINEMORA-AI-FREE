# CINEMORA Free — deploy-ready package

This is a small web app that creates a narrated MP4 from a text prompt.
It needs a Gemini API key and a server with FFmpeg. **GitHub Pages alone cannot run it** because GitHub Pages only hosts static websites.

## Easiest deployment (phone-friendly)

1. Upload this whole `cinemora-free` folder to a new GitHub repository.
2. Create/sign in to Render and choose **New → Blueprint**; connect that repository.
3. Render reads `render.yaml`. When prompted, add `GEMINI_API_KEY` as a secret environment variable.
4. Create a Gemini API key at https://aistudio.google.com/ and paste it into Render's `GEMINI_API_KEY` field. Never put the real key in GitHub.
5. Deploy. When Render says **Live**, open the Render URL. `/health` should show `{"ok":true,"app":"CINEMORA"}`.

## Local run (computer)

- Install Node.js 20+ and FFmpeg (including ffprobe).
- Copy `.env.example` to `.env` and add your Gemini key.
- Run `npm install`, then `node --env-file=.env server.js`.
- Open http://localhost:3000

## Important

- Video generation uses Gemini for the script, Pollinations for images, Edge TTS for narration, and FFmpeg for editing. Those external services must be reachable.
- Free hosting can sleep, restart, or have limited CPU/storage. Generated MP4s on a free instance may not be permanent; download each video when it finishes.
- The Gemini API key may have usage limits or charges depending on the account and current Google terms.
- Do not share your API key or commit `.env` to GitHub.
