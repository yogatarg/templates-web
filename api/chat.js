import { SYSTEM_PROMPT } from './_knowledge.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Hanya situs ini yang boleh memakai fungsi ini.
const ALLOWED = [
  'https://templates-web-nu.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const MAX_RIWAYAT = 12;   // pesan yang diingat
const MAX_PANJANG = 2000; // batas panjang satu pesan

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const diizinkan = ALLOWED.includes(origin);

  if (diizinkan) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Tolak sebelum memanggil Gemini. Tanpa ini, situs lain yang menempelkan
  // widget ini tetap menghabiskan kuota kita meski jawabannya diblokir browser.
  // Peramban selalu menyertakan Origin pada POST, jadi yang tanpa Origin pun ditolak.
  if (!diizinkan) {
    console.warn('Origin ditolak:', origin || '(kosong)');
    return res.status(403).json({ error: 'Akses ditolak.' });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('GEMINI_API_KEY belum diset di environment Vercel');
    return res.status(500).json({ error: 'Server belum dikonfigurasi.' });
  }

  try {
    const { message, history } = req.body ?? {};

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Pesan kosong.' });
    }
    if (message.length > MAX_PANJANG) {
      return res.status(400).json({ error: 'Pesan terlalu panjang.' });
    }

    // Riwayat dari klien — ambil seperlunya dan buang yang bentuknya tidak wajar.
    const riwayat = Array.isArray(history) ? history.slice(-MAX_RIWAYAT) : [];
    const contents = riwayat
      .filter((m) => m && typeof m.text === 'string' && (m.role === 'user' || m.role === 'bot'))
      .map((m) => ({
        role: m.role === 'bot' ? 'model' : 'user',
        parts: [{ text: String(m.text).slice(0, MAX_PANJANG) }],
      }));

    contents.push({ role: 'user', parts: [{ text: message }] });

    const payload = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: 700 },
    });

    // Tingkat gratis Gemini sering membalas 503 (model sedang padat) atau 429
    // (terlalu sering). Keduanya sementara, jadi dicoba ulang dengan jeda naik.
    let r;
    for (let percobaan = 0; percobaan < 3; percobaan++) {
      if (percobaan > 0) await new Promise((s) => setTimeout(s, percobaan * 1200));

      r = await fetch(`${ENDPOINT}/${MODEL}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      if (r.ok) break;
      if (r.status !== 503 && r.status !== 429) break; // error lain: tidak ada gunanya diulang
      console.warn(`Gemini ${r.status}, percobaan ${percobaan + 1}/3`);
    }

    if (!r.ok) {
      const detail = await r.text();
      console.error('Gemini menolak:', r.status, detail.slice(0, 500));
      // Jangan teruskan detail error ke pengunjung.
      const pesan =
        r.status === 503 || r.status === 429
          ? 'Asisten sedang sibuk. Coba kirim ulang sebentar lagi ya.'
          : 'Asisten sedang tidak bisa dihubungi.';
      return res.status(502).json({ error: pesan });
    }

    const data = await r.json();
    const reply = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text)
      .filter(Boolean)
      .join('')
      .trim();

    if (!reply) {
      console.error('Balasan Gemini kosong:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: 'Asisten sedang tidak bisa dihubungi.' });
    }

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Kesalahan tak terduga:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan. Coba lagi sebentar.' });
  }
}
