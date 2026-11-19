
import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EdgeTTS } from 'node-edge-tts';

const app = express();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC));

app.get('/health', (_req, res) =>
  res.json({ ok: true, app: 'CINEMORA' })
);

const OUT = path.join(ROOT, 'output');
await fs.mkdir(OUT, { recursive: true });

app.use('/output', express.static(OUT));

const jobs = new Map();

const VOICES = {
  hi: ['hi-IN-SwaraNeural', 'hi-IN'],
  en: ['en-US-AriaNeural', 'en-US']
};

const SIZES = {
  '9:16': [720, 1280],
  '16:9': [1280, 720]
};

const run = (cmd, args) => new Promise((res, rej) => {
  const p = spawn(cmd, args);
  let err = '';

  p.stderr.on('data', d => (err += d));

  p.on('error', e =>
    rej(new Error(`${cmd} chala nahi: ${e.message}`))
  );

  p.on('close', c =>
    c === 0
      ? res()
      : rej(new Error(`${cmd} fail (${c}): ${err.slice(-400)}`))
  );
});

const duration = file => new Promise(res => {
  let o = '';

  const p = spawn('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file
  ]);

  p.stdout.on('data', d => (o += d));
  p.on('error', () => res(0));
  p.on('close', () => res(parseFloat(o) || 0));
});

// GEMINI SCRIPT GENERATOR WITH RETRY + BACKUP
async function makeScript(prompt, lang) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error('GEMINI_API_KEY missing');
  }

  const primaryModel =
    process.env.GEMINI_MODEL || 'gemini-3.8-flash';

  const fallbackModel =
    process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';

  const models = [...new Set([
    primaryModel,
    fallbackModel
  ])];

  const ask = `Write a short video script (5 to 7 scenes) for: "${prompt}". Narration language: ${lang === 'hi' ? 'Hindi (Devanagari)' : 'English'}. Return only JSON: {"title":"","scenes":[{"narration":"1-2 short sentences","image_prompt":"detailed cinematic visual description in English"}]}`;

  let lastError;

  for (const model of models) {
    console.log(`Starting Gemini model: ${model}`);

    for (let attempt = 1; attempt <= 4; attempt++) {
      let response;

      try {
        console.log(
          `Gemini ${model}: attempt ${attempt}/4`
        );

        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              contents: [
                { parts: [{ text: ask }] }
              ],
              generationConfig: {
                responseMimeType: 'application/json'
              }
            }),
            signal: AbortSignal.timeout(120000)
          }
        );

        if (!response.ok) {
          const errorText = await response.text();

          const error = new Error(
            `Gemini ${model} error ${response.status}: ${errorText.slice(0, 300)}`
          );

          lastError = error;

          if (response.status === 404) {
            console.log(
              `Model ${model} not available. Trying backup model.`
            );
            break;
          }

          if (
            ![408, 429, 500, 502, 503, 504].includes(response.status)
          ) {
            throw error;
          }

          throw error;
        }

        const result = await response.json();

        const responseText =
          result.candidates?.[0]?.content?.parts
            ?.map(part => part.text || '')
            .join('');

        if (!responseText) {
          throw new Error(
            'Gemini returned an empty response'
          );
        }

        const cleanText = responseText
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/, '')
          .trim();

        const data = JSON.parse(cleanText);

        if (
          !Array.isArray(data.scenes) ||
          data.scenes.length === 0
        ) {
          throw new Error('Script me scenes nahi mile');
        }

        console.log(
          `Script generated successfully using ${model}`
        );

        return data;

      } catch (error) {
        lastError = error;

        const errorMessage = [
          error.message || '',
          error.cause?.message || '',
          error.cause?.code || '',
          error.code || ''
        ].join(' ');

        console.error(
          `Gemini ${model}, attempt ${attempt}:`,
          errorMessage
        );

        const retryable =
          /fetch failed|HeadersTimeoutError|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_HEADERS_TIMEOUT|AbortError/i.test(errorMessage) ||
          [408, 429, 500, 502, 503, 504].some(status =>
            errorMessage.includes(` ${status}:`)
          );

        if (!retryable) {
          throw error;
        }

        if (attempt < 4) {
          const delay = 3000 * (2 ** (attempt - 1));

          console.log(
            `Temporary error. Retrying in ${delay / 1000} seconds...`
          );

          await new Promise(resolve =>
            setTimeout(resolve, delay)
          );
        } else {
          console.log(
            `Retries exhausted for ${model}.`
          );
        }
      }
    }

    console.log(
      `Trying next Gemini model after ${model}`
    );
  }

  throw lastError || new Error(
    'All Gemini models unavailable'
  );
}

// IMAGE GENERATOR
async function makeImage(text, file, w, h) {
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(
      text + ', cinematic, dramatic lighting, high detail'
    )}?width=${w}&height=${h}&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;

  const r = await fetch(url, {
    signal: AbortSignal.timeout(120000)
  });

  if (!r.ok) {
    throw new Error(`Image error ${r.status}`);
  }

  await fs.writeFile(
    file,
    Buffer.from(await r.arrayBuffer())
  );
}

// VIDEO CLIP GENERATOR
async function makeClip(img, wav, out, w, h) {
  const dur = (await duration(wav)) + 0.6;
  const frames = Math.ceil(dur * 25);

  const vf =
    `scale=${w * 2}:${h * 2},zoompan=z='min(zoom+0.0008,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=25,fade=t=in:d=0.4,fade=t=out:st=${(dur - 0.4).toFixed(2)}:d=0.4,format=yuv420p`;

  await run('ffmpeg', [
    '-y',
    '-i', img,
    '-i', wav,
    '-vf', vf,
    '-af', 'apad',
    '-t', dur.toFixed(2),
    '-r', '25',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    out
  ]);
}

// MAIN VIDEO PIPELINE
async function pipeline(id, prompt, lang, format) {
  const job = jobs.get(id);

  const set = (step, pct) =>
    Object.assign(job, { step, pct });

  const dir = path.join(OUT, id);

  await fs.mkdir(dir, { recursive: true });

  const [w, h] = SIZES[format] || SIZES['9:16'];
  const [voice, vlang] = VOICES[lang] || VOICES.hi;

  try {
    set('Script ban rahi hai (Gemini)...', 5);

    const script = await makeScript(prompt, lang);

    job.title = script.title;

    const n = script.scenes.length;
    const clips = [];

    for (let i = 0; i < n; i++) {
      const s = script.scenes[i];
      const base = path.join(dir, `s${i}`);

      set(
        `Scene ${i + 1}/${n}: image ban rahi hai...`,
        10 + (i / n) * 70
      );

      await makeImage(
        s.image_prompt,
        base + '.jpg',
        w,
        h
      );

      set(
        `Scene ${i + 1}/${n}: voiceover ban raha hai...`,
        10 + ((i + 0.4) / n) * 70
      );

      await new EdgeTTS({
        voice,
        lang: vlang
      }).ttsPromise(
        s.narration,
        base + '.mp3'
      );

      set(
        `Scene ${i + 1}/${n}: edit ho raha hai...`,
        10 + ((i + 0.7) / n) * 70
      );

      await makeClip(
        base + '.jpg',
        base + '.mp3',
        base + '.mp4',
        w,
        h
      );

      clips.push(base + '.mp4');
    }

    set('Final video jod rahe hain...', 88);

    await fs.writeFile(
      path.join(dir, 'list.txt'),
      clips.map(c =>
        `file '${c.replace(/'/g, "'\\''")}'`
      ).join('\n')
    );

    const joined = path.join(dir, 'joined.mp4');

    await run('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', path.join(dir, 'list.txt'),
      '-c', 'copy',
      joined
    ]);

    const final = path.join(dir, 'final.mp4');
    const music = path.join(PUBLIC, 'music.mp3');

    const hasMusic = await fs.access(music)
      .then(() => true, () => false);

    if (hasMusic) {
      await run('ffmpeg', [
        '-y',
        '-i', joined,
        '-stream_loop', '-1',
        '-i', music,
        '-filter_complex',
        '[1:a]volume=0.12[m];[0:a][m]amix=inputs=2:duration=first[a]',
        '-map', '0:v',
        '-map', '[a]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-shortest',
        final
      ]);
    } else {
      await fs.copyFile(joined, final);
    }

    Object.assign(job, {
      status: 'done',
      step: 'Video ready',
      pct: 100,
      url: `/output/${id}/final.mp4`
    });

    console.log(`Job ${id} completed successfully`);

  } catch (e) {
    console.error('Pipeline error:', e);

    Object.assign(job, {
      status: 'error',
      error: e.message
    });
  }
}

// GENERATE API
app.post('/api/generate', (req, res) => {
  const {
    prompt,
    lang = 'hi',
    format = '9:16'
  } = req.body || {};

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({
      error: 'Prompt likho'
    });
  }

  const id = randomUUID().slice(0, 8);

  jobs.set(id, {
    status: 'running',
    step: 'Shuru...',
    pct: 0
  });

  pipeline(id, prompt.trim(), lang, format)
    .catch(error => {
      console.error('Unexpected pipeline error:', error);

      Object.assign(jobs.get(id), {
        status: 'error',
        error: error.message
      });
    });

  res.json({ id });
});

// JOB STATUS API
app.get('/api/status/:id', (req, res) => {
  const j = jobs.get(req.params.id);

  j
    ? res.json(j)
    : res.status(404).json({
        error: 'Job nahi mila'
      });
});

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', () =>
  console.log('CINEMORA ready on port ' + PORT)
);
