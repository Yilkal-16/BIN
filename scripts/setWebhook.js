require('dotenv').config();
const https = require('https');

function setWebhook(botToken, url) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ url });
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/setWebhook`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(JSON.parse(data)));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const botToken = process.env.BOT_TOKEN;
  const backendUrl = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL;
  if (!botToken) throw new Error('BOT_TOKEN is not set');
  if (!backendUrl) throw new Error('Set BACKEND_URL to your deployed Render backend URL first, e.g. https://your-app.onrender.com');

  const webhookUrl = `${backendUrl.replace(/\/$/, '')}/api/webhook`;
  console.log('Setting webhook to:', webhookUrl);

  const result = await setWebhook(botToken, webhookUrl);
  console.log(result);
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error('setWebhook failed:', err.message);
  process.exit(1);
});
