import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import dotenv from 'dotenv';
import { ProxyAgent } from 'undici';

// Load environment variables from .env file
dotenv.config();

let TARGET_HOST = process.env.TARGET_HOST || 'https://tokendance.space';
let PORT = process.env.PORT || 7860;

// Parse keys from KEY environment variable
let rawKeys = process.env.KEY || '';
let keys = rawKeys.split(',')
  .map(k => k.trim())
  .filter(k => k.length > 0);

// Client authentication password
let clientPassword = process.env.PASSWORD || '';

// Outbound Proxy
let proxyUrl = process.env.OUTBOUND_PROXY || '';

// Rotation mode: round-robin or exhaustion
let mode = process.env.KEY_MODE || 'round-robin';

// Running key tracker index
let currentIndex = 0;

console.log(`[Init] Loaded ${keys.length} API key(s) for rotation.`);
keys.forEach((k, idx) => {
  console.log(`  Key [${idx + 1}]: ${maskKey(k)}`);
});
if (clientPassword) {
  console.log(`[Init] Client authentication is ENABLED (password: ${clientPassword}).`);
} else {
  console.log(`[Init] Client authentication is DISABLED (no PASSWORD set in environment).`);
}
console.log(`[Init] Proxy Mode: ${mode}`);
if (proxyUrl) {
  console.log(`[Init] Outbound Proxy: ${proxyUrl}`);
}

/**
 * Mask key for logging purposes.
 */
function maskKey(key) {
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}...${key.slice(-5)}`;
}

/**
 * Persists current in-memory configurations back to the .env file.
 */
function saveConfigToEnv() {
  try {
    const envPath = path.resolve('.env');
    let content = '';
    content += `# Target API Host\nTARGET_HOST=${TARGET_HOST}\n\n`;
    content += `# Proxy Port (defaults to 7860 if not specified)\nPORT=${PORT}\n\n`;
    content += `# API Keys for rotation, separated by comma\nKEY=${keys.join(',')}\n\n`;
    content += `# Client authentication password\nPASSWORD=${clientPassword}\n\n`;
    content += `# Outbound proxy (optional, e.g. http://127.0.0.1:7890)\nOUTBOUND_PROXY=${proxyUrl || ''}\n\n`;
    content += `# Rotation mode: round-robin or exhaustion\nKEY_MODE=${mode}\n`;
    
    fs.writeFileSync(envPath, content, 'utf8');
    console.log(`[Config] Config written to .env for persistence.`);
  } catch (err) {
    console.error(`[Config] Failed to save config to .env:`, err.message);
  }
}

/**
 * Helper to get a ProxyAgent dispatcher if proxyUrl is set.
 */
function getProxyDispatcher(url) {
  if (!url) return undefined;
  try {
    return new ProxyAgent(url);
  } catch (err) {
    console.error(`[Proxy] Error creating ProxyAgent for "${url}":`, err.message);
    return undefined;
  }
}

/**
 * Read request body stream into a single Buffer.
 */
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', err => reject(err));
  });
}

/**
 * Helper to read JSON request body.
 */
async function readJsonBody(req) {
  const buffer = await readBody(req);
  if (!buffer || buffer.length === 0) return {};
  return JSON.parse(buffer.toString('utf8'));
}

/**
 * Proxies standard requests with round-robin or exhaustion retry mechanisms.
 */
async function handleProxyRequest(req, res, requestId) {
  const start = Date.now();
  
  if (keys.length === 0) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'No API keys configured on proxy server.' } }));
    return;
  }

  // 1. Perform password check for proxy requests
  const authHeader = req.headers['authorization'];
  if (clientPassword) {
    const expectedBearer = `Bearer ${clientPassword}`;
    if (authHeader !== expectedBearer && authHeader !== clientPassword) {
      console.warn(`[${requestId}] Unauthorized request: ${req.method} ${req.url} (Invalid or missing PASSWORD)`);
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: {
          message: 'Unauthorized - Invalid or missing API key/password',
          type: 'invalid_request_error'
        }
      }));
      return;
    }
  }

  // 2. Buffer request body to support retries on failures (e.g. 429/402/401)
  let bodyBuffer = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      bodyBuffer = await readBody(req);
      
      // Check if it is a JSON request and target model is deepseek
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json') && bodyBuffer && bodyBuffer.length > 0) {
        try {
          const bodyJson = JSON.parse(bodyBuffer.toString('utf8'));
          if (bodyJson && typeof bodyJson.model === 'string') {
            const modelNameLower = bodyJson.model.toLowerCase();
            const isDeepSeek = modelNameLower.includes('deepseek');
            const isQwen = modelNameLower.includes('qwen');
            const isMimo = modelNameLower.includes('mimo');
            const isSeed = modelNameLower.includes('seed-2.0-pro') || modelNameLower.includes('seed-2.0-lite');

            if (isDeepSeek || isQwen || isMimo || isSeed) {
              // Check shared conditions
              let hasThinkTag = false;
              if (Array.isArray(bodyJson.messages)) {
                hasThinkTag = bodyJson.messages.some(msg => 
                  msg && typeof msg.content === 'string' && msg.content.includes('<||think:True||>')
                );
              }

              const hasReasoningEffort = bodyJson.reasoning_effort && 
                typeof bodyJson.reasoning_effort === 'string' && 
                bodyJson.reasoning_effort.toLowerCase() !== 'none';

              // 1. DeepSeek specific logic
              if (isDeepSeek) {
                // Add provider configuration
                bodyJson.provider = {
                  order: ["deepseek"],
                  only: ["deepseek"],
                  ignore: ["moonshot"],
                  allow_fallbacks: true
                };

                // Control thinking chain for non-OCR models
                if (!modelNameLower.includes('deepseek-ocr-2')) {
                  const hasThinkingUploaded = bodyJson.thinking !== undefined;
                  if (!hasThinkingUploaded) {
                    if (hasThinkTag || hasReasoningEffort) {
                      console.log(`[${requestId}] DeepSeek thinking chain left OPEN (hasThinkTag: ${hasThinkTag}, hasReasoningEffort: ${hasReasoningEffort})`);
                    } else {
                      bodyJson.thinking = {
                        type: "disabled"
                      };
                      console.log(`[${requestId}] DeepSeek thinking chain set to DISABLED by default`);
                    }
                  } else {
                    console.log(`[${requestId}] DeepSeek thinking chain using client-provided configuration:`, JSON.stringify(bodyJson.thinking));
                  }
                }
                console.log(`[${requestId}] Added provider configuration for DeepSeek model: ${bodyJson.model}`);
              }

              // 2. Qwen specific logic
              if (isQwen) {
                const hasEnableThinkingUploaded = bodyJson.enable_thinking !== undefined;
                if (!hasEnableThinkingUploaded) {
                  if (hasThinkTag || hasReasoningEffort) {
                    bodyJson.enable_thinking = true;
                    console.log(`[${requestId}] Qwen thinking chain set to ENABLED (hasThinkTag: ${hasThinkTag}, hasReasoningEffort: ${hasReasoningEffort})`);
                  } else {
                    bodyJson.enable_thinking = false;
                    console.log(`[${requestId}] Qwen thinking chain set to DISABLED by default`);
                  }
                } else {
                  console.log(`[${requestId}] Qwen thinking chain using client-provided configuration: enable_thinking = ${bodyJson.enable_thinking}`);
                }
              }

              // 3. Mimo specific logic
              if (isMimo) {
                bodyJson.provider = {
                  order: ["xiaomi", "infini-ai"],
                  ignore: ["agentuniverse", "alibaba"],
                  allow_fallbacks: true
                };
                console.log(`[${requestId}] Added provider configuration for Mimo model: ${bodyJson.model}`);
              }

              // 4. Seed specific logic
              if (isSeed) {
                const hasThinkingUploaded = bodyJson.thinking !== undefined;
                if (!hasThinkingUploaded) {
                  if (hasThinkTag || hasReasoningEffort) {
                    console.log(`[${requestId}] Seed thinking chain left OPEN (hasThinkTag: ${hasThinkTag}, hasReasoningEffort: ${hasReasoningEffort})`);
                  } else {
                    bodyJson.thinking = {
                      type: "disabled"
                    };
                    console.log(`[${requestId}] Seed thinking chain set to DISABLED by default`);
                  }
                } else {
                  console.log(`[${requestId}] Seed thinking chain using client-provided configuration:`, JSON.stringify(bodyJson.thinking));
                }
              }

              bodyBuffer = Buffer.from(JSON.stringify(bodyJson), 'utf8');
            }
          }
        } catch (e) {
          // Ignore JSON parsing errors for malformed bodies
        }
      }
    } catch (err) {
      console.error(`[${requestId}] Error reading request body:`, err.message);
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }));
      return;
    }
  }

  let attempts = 0;
  // In exhaustion mode, we can retry using up to the total number of keys.
  // In round-robin, we still try next keys if the selected key returns rate limit or quota errors.
  const maxAttempts = keys.length;

  while (attempts < maxAttempts) {
    const keyIndex = currentIndex;
    const selectedKey = keys[keyIndex];
    if (!selectedKey) {
      // Index is out of bounds somehow, reset
      currentIndex = 0;
      attempts++;
      continue;
    }

    const maskedKey = maskKey(selectedKey);
    console.log(`[${requestId}] Attempt ${attempts + 1} | Using Key [${keyIndex + 1}/${keys.length}]: ${maskedKey} | Mode: ${mode}`);
    
    // Prepare forwarding headers
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase() === 'host') continue;
      headers[name] = value;
    }
    headers['authorization'] = `Bearer ${selectedKey}`;
    if (bodyBuffer) {
      headers['content-length'] = bodyBuffer.length.toString();
    }
    
    const targetUrl = `${TARGET_HOST}${req.url}`;
    const dispatcher = getProxyDispatcher(proxyUrl);
    
    try {
      const fetchOptions = {
        method: req.method,
        headers: headers,
        duplex: 'half',
      };
      
      if (bodyBuffer) {
        fetchOptions.body = bodyBuffer;
      }
      
      if (dispatcher) {
        fetchOptions.dispatcher = dispatcher;
      }
      
      const response = await fetch(targetUrl, fetchOptions);
      
      // Keys are considered exhausted/failed if they return:
      // - 429 (Rate limit)
      // - 402 (Payment required / Insufficient balance)
      // - 401 (Unauthorized - usually means key has been deactivated)
      const isFailedKey = response.status === 429 || response.status === 402 || response.status === 401;
      
      if (isFailedKey && keys.length > 1) {
        console.warn(`[${requestId}] Key [${keyIndex + 1}] returned status ${response.status}. Switching key...`);
        // Immediately advance key pointer to next key
        currentIndex = (currentIndex + 1) % keys.length;
        attempts++;
        continue; // Try next key in loop
      }
      
      // If we got a successful response (or an error that is not related to key exhaustion),
      // we proceed to write back the response.
      
      // If we are in round-robin mode, advance the key pointer for the next incoming request
      if (mode === 'round-robin') {
        currentIndex = (currentIndex + 1) % keys.length;
      }
      
      // Write response status
      res.statusCode = response.status;
      res.statusMessage = response.statusText;
      
      // Copy response headers
      for (const [name, value] of response.headers.entries()) {
        const lowerName = name.toLowerCase();
        if (lowerName === 'transfer-encoding' || lowerName === 'connection') {
          continue;
        }
        res.setHeader(name, value);
      }
      
      // Stream response body
      if (response.body) {
        const responseStream = Readable.fromWeb(response.body);
        responseStream.pipe(res);
        
        responseStream.on('end', () => {
          const duration = Date.now() - start;
          console.log(`[${requestId}] Response completed | Status ${response.status} (${duration}ms)`);
        });
        
        responseStream.on('error', (err) => {
          console.error(`[${requestId}] Stream error:`, err.message);
          // If a stream fails midway in exhaustion mode, we rotate the key so future requests use another key
          if (mode === 'exhaustion') {
            currentIndex = (currentIndex + 1) % keys.length;
            console.log(`[${requestId}] Key rotated due to midway stream error. New key index: [${currentIndex + 1}]`);
          }
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'Stream interrupted' }));
          }
        });
      } else {
        res.end();
        const duration = Date.now() - start;
        console.log(`[${requestId}] Response completed (no body) | Status ${response.status} (${duration}ms)`);
      }
      
      return; // Handled successfully, break out of handler
      
    } catch (error) {
      console.error(`[${requestId}] Connection error on Key [${keyIndex + 1}]:`, error.message);
      
      // If fetch fails (network connection issues) and we have other keys, try the next key
      if (keys.length > 1) {
        currentIndex = (currentIndex + 1) % keys.length;
        attempts++;
        continue;
      }
      
      const duration = Date.now() - start;
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: {
            message: 'Bad Gateway - Connection error',
            details: error.message
          }
        }));
      }
      return;
    }
  }
  
  // If we exhausted all keys
  console.error(`[${requestId}] All ${keys.length} keys were exhausted/failed.`);
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    error: {
      message: 'All configured API keys returned error status (401/402/429) or failed to connect.'
    }
  }));
}

// Create HTTP Server
const server = http.createServer(async (req, res) => {
  const requestId = Math.random().toString(36).substring(2, 9);
  
  // Parse URL pathname
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  
  // 1. Redirect / Serve Control Panel
  if (pathname === '/' || pathname === '/dashboard') {
    try {
      const dashboardPath = path.resolve('dashboard.html');
      const html = fs.readFileSync(dashboardPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error loading dashboard.html');
    }
    return;
  }
  
  // 2. Control Panel API: Login
  if (pathname === '/api/login' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const isMatch = body.password === clientPassword;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: isMatch }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }
  
  // Control Panel API Authorization Helper
  function isAuthorized() {
    if (!clientPassword) return true;
    const authHeader = req.headers['authorization'];
    const expectedBearer = `Bearer ${clientPassword}`;
    return authHeader === expectedBearer || authHeader === clientPassword;
  }
  
  // 3. Control Panel API: Get Config
  if (pathname === '/api/config' && req.method === 'GET') {
    if (!isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      keys,
      currentIndex,
      mode,
      proxyUrl,
      hasPassword: !!clientPassword
    }));
    return;
  }
  
  // 4. Control Panel API: Save Config
  if (pathname === '/api/config' && req.method === 'POST') {
    if (!isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readJsonBody(req);
      
      // Update in-memory configurations
      if (Array.isArray(body.keys)) {
        keys = body.keys.map(k => k.trim()).filter(k => k.length > 0);
      }
      if (body.mode === 'round-robin' || body.mode === 'exhaustion') {
        mode = body.mode;
      }
      if (typeof body.proxyUrl === 'string') {
        proxyUrl = body.proxyUrl.trim();
      }
      if (typeof body.password === 'string') {
        clientPassword = body.password;
      }
      
      // Keep pointer within range
      if (currentIndex >= keys.length) {
        currentIndex = Math.max(0, keys.length - 1);
      }
      
      // Persist values to .env
      saveConfigToEnv();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }
  
  // 5. Control Panel API: Manual Key Switch
  if (pathname === '/api/switch-key' && req.method === 'POST') {
    if (!isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readJsonBody(req);
      const index = parseInt(body.index, 10);
      
      if (!isNaN(index) && index >= 0 && index < keys.length) {
        currentIndex = index;
        console.log(`[Config] Manually switched active key index to [${currentIndex + 1}/${keys.length}]`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid key index' }));
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 6. Otherwise, perform proxy routing
  await handleProxyRequest(req, res, requestId);
});

// Start server
server.listen(PORT, () => {
  console.log(`[Server] Proxy server is running at http://localhost:${PORT}`);
  console.log(`[Server] Proxying requests to ${TARGET_HOST}`);
});
